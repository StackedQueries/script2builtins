---
title: Trap internals
nav_order: 3
---

# Trap internals

This page documents the in-page trap script in enough detail that you
can extend it, audit it, or port the technique to a different
instrumentation host (CDP scripts, browser extension, etc.).

## Lifetime ordering

The trap script must run **before any page script**. Playwright's
`addInitScript` runs after the global object is created but before any
inline `<script>` element executes — that's the correct window.

The very first thing the trap does is snapshot pristine references:

```js
const __$ = {
  Object,
  Reflect,
  Proxy,
  Function,
  Error,
  WeakMap,
  WeakSet,
  Map,
  Set,
  Array,
  fnCall:  Function.prototype.call,
  fnApply: Function.prototype.apply,
  fnBind:  Function.prototype.bind,
  defineProperty: Object.defineProperty,
  getOwnDescriptor: Object.getOwnPropertyDescriptor,
  getPrototypeOf: Object.getPrototypeOf,
  setPrototypeOf: Object.setPrototypeOf,
  console: { log: console.log.bind(console) },
  performance: { now: performance.now.bind(performance) },
};
```

Every subsequent line in the trap uses `__$` instead of the (now
mutable) globals. This is why a script that replaces
`window.Object` after page load cannot blind us.

## Event buffer

A single `Array` collects events, with a byte cap that drops the
oldest events when exceeded. The drop counter is broken down by event
kind so high-signal losses (`sink`, `hazard`) are visible to the user
in `summary.bufferOverflowsByKind`:

```js
const events = [];
let seq = 0;
let bytes = 0;
let overflows = 0;
const overflowsByKind = { access: 0, sink: 0, hazard: 0 };

function push(ev) {
  ev.seq = seq++;
  ev.t = __$.perfNow();
  const size = estimateSize(ev);
  while (bytes + size > config.bufferByteCap && events.length > 0) {
    const dropped = events.shift();
    bytes -= estimateSize(dropped);
    overflows++;
    overflowsByKind[dropped.kind] = (overflowsByKind[dropped.kind] || 0) + 1;
  }
  events.push(ev);
  bytes += size;
}
```

Drain happens on the driver's schedule (`page.evaluate` returning
`channel.drain(since)`). For chatty pages we can switch to a Playwright
binding (`page.exposeBinding`) so the in-page side pushes to Node
instead of being pulled — keeps memory bounded.

## Drain channel

The drain channel is installed under a **per-build random name** on
`window`:

```js
__$.defineProperty(win, config.channelName, {
  value: channel,
  writable: false,
  configurable: false,
  enumerable: false,
});
```

`config.channelName` defaults to `"__s2b_<6 hex bytes>"` so a page
that defensively checks for `window.__s2bRt` (the v1 name) doesn't
find it. The chosen name is surfaced on `Session.channelName` so
external code can drain manually when needed.

The channel exposes:

| field                       | what |
|-----------------------------|------|
| `drain(since)`              | array of events with `seq > since` |
| `flush()`                   | drain everything, reset the buffer |
| `cursor`                    | latest `seq` issued |
| `bufferOverflows`           | total drop count |
| `bufferOverflowsByKind`     | `{ access, sink, hazard }` |
| `sectionErrors`             | per-section installation failures |
| `version`, `trapHash`       | self-identification |

## Property-access traps

For every entry in `watchedRoots()`, we install one of two strategies:

### Strategy A — `Proxy` wrapper (Phase 4)

```js
const realNavigator = navigator;
const navProxy = new __$.Proxy(realNavigator, {
  get(t, k, r) {
    if (typeof k === "string") {
      push({ kind: "access", chain: ["navigator", k], called: false,
             firstStringArg: null, via: "proxy", stack: getStack() });
    }
    const v = __$.Reflect.get(t, k, r);
    // If the property is a function, wrap it so the call is observed too.
    return typeof v === "function" ? wrapMethod(["navigator", k], v) : v;
  },
});
__$.defineProperty(window, "navigator", { get: () => navProxy, configurable: true });
```

This catches `navigator[x]` for *any* `x` — the central blind spot for
fully dynamic keys.

### Strategy B — pinpoint descriptor getter

For prototype-side methods that don't go through a root identifier
(e.g. `canvasEl.getContext("2d")`), we patch the descriptor on the
prototype directly:

```js
const proto = HTMLCanvasElement.prototype;
const orig = __$.getOwnDescriptor(proto, "getContext").value;
__$.defineProperty(proto, "getContext", {
  value: wrapMethod(["*", "getContext"], orig),
  writable: true, configurable: true,
});
```

The `["*", "getContext"]` chain shape matches the catalog's `"*.X"`
wildcard convention so `matchAccesses` resolves it the same way the
static pass does.

## Method-call wrapping

`wrapMethod(chain, fn)` returns a function that:

1. Captures the call (chain + first string arg + stack).
2. Delegates to the original via `__$.fnApply`.
3. If the return value is an object whose properties are *also* in the
   catalog, returns a Proxy over the return value so chained accesses
   (`canvas.getContext("2d").measureText("X")`) keep firing.

The chained-return Proxying is what catches things like
`AudioContext().createOscillator().frequency.value` — the access on
`.frequency.value` needs the Proxy hop on the `OscillatorNode`
returned by `createOscillator()`.

## Sink wrappers

Each `NetworkSinkKind` from
[`script2builtins/types`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/types.ts)
gets a wrapper that emits one `RuntimeSinkEvent` per outbound message:

| Kind                  | Hook                                                    |
|-----------------------|---------------------------------------------------------|
| `fetch`               | `window.fetch`                                          |
| `xhr`                 | `XMLHttpRequest.prototype.{open,setRequestHeader,send}` |
| `sendBeacon`          | `Navigator.prototype.sendBeacon`                        |
| `websocket-open`      | `WebSocket` constructor                                 |
| `websocket-send`      | `WebSocket.prototype.send`                              |
| `eventsource`         | `EventSource` constructor                               |
| `image-src`           | `HTMLImageElement.prototype` `src` setter               |
| `script-src`          | `HTMLScriptElement.prototype` `src` setter              |
| `worker`              | `Worker` constructor                                    |
| `shared-worker`       | `SharedWorker` constructor                              |
| `service-worker`      | `navigator.serviceWorker.register`                      |
| `importScripts`       | `WorkerGlobalScope.prototype.importScripts`             |
| `navigation`          | `location.assign` / `replace` / `href` setter           |

Body capture follows the runtime's natural types: `string`, `FormData`
(iterate `.entries()`), `URLSearchParams`, `Blob` (sniff a `text/`
content-type), `ArrayBuffer` / typed arrays (base64-preview up to the
configured limit). The shape is recorded into `RuntimeSinkEvent.body`.

## Dynamic-execution traps (Phase 3)

```js
const origEval = eval; // resolved before page scripts can replace it
__$.defineProperty(window, "eval", {
  value: function (src) {
    if (typeof src === "string") {
      push({ kind: "hazard", hazardKind: "eval", source: src, stack: getStack() });
    }
    return origEval(src);
  },
  writable: true, configurable: true,
});
```

`Function` and `new Function` are the same idea (and the same hook —
since `Function` is a constructor, we replace it on `window` and on
its own prototype reference). `setTimeout("string", ...)` and the
string form of `setInterval` are wrapped on `window`. Dynamic
`import()` is replaced by a wrapping function returned from a top-level
helper because `import` is a keyword, not a callable — we cannot trap
the keyword directly, but we can scan the source for `import(...)`
calls in the static pass and emit them as hazards, then rely on the
dynamic load showing up as a `script-src` sink at runtime.

## Stack capture

```js
function getStack(skip = 2) {
  const e = new __$.Error();
  const lines = (e.stack || "").split("\n").slice(skip, skip + STACK_LIMIT);
  return lines.join("\n");
}
```

The first parseable line is what we record as `scriptUrl` /
`line` / `column` on the event. Stack capture cost is the dominant
runtime overhead; we cap it (`STACK_LIMIT`, default 8) and parse only
on the driver side.

## Worker instrumentation (Phase 8)

When `trapWorkers: true` (default), the trap wraps `new Worker(url)`
to construct a small bootstrap blob that imports the trap source
*inside the worker* before importing the user's URL:

```js
// Driver-side: publish the trap source under a known global
//   before injecting the main trap.
await context.addInitScript({
  content: `;(function(){
    try { globalThis.__s2bWorkerTrap = ${JSON.stringify(trap.source)}; } catch(e){}
  })();`,
});
await context.addInitScript({ content: trap.source });
```

```js
// Trap-side: wrap Worker.
const userUrl = String(url);
const bootSrc =
  `try { importScripts(${JSON.stringify(workerTrapBlobUrl)}); } catch (e) {}\n` +
  `try { importScripts(${JSON.stringify(userUrl)}); } catch (e) { throw e; }\n`;
const bootBlob = new Blob([bootSrc], { type: "application/javascript" });
return new OrigWorker(URL.createObjectURL(bootBlob), opts);
```

Skipped paths:

- `{ type: "module" }` workers — module workers use `import`, not
  `importScripts`. Falls through to the original constructor.
- `SharedWorker` — `importScripts(<blob>)` support in shared-worker
  scopes is browser-version-sensitive. Falls through.

The sink event (`sinkKind: "worker"`) still fires for both skipped
paths so the constructor call is visible in the report.

## Reflect.get wrap (opt-in)

`config.trapReflectGet` (default off) wraps `Reflect.get`:

```js
const wrappedReflectGet = function (target, key, receiver) {
  // Identity-match target against the watched root objects we
  // resolved at trap-install time. No-op for everything else.
  for (let i = 0; i < watchedRootObjs.length; i++) {
    if (watchedRootObjs[i].obj === target) {
      push({ kind: "access", chain: [watchedRootObjs[i].name, key],
             called: false, via: "reflect", stack: getStack(1) });
      break;
    }
  }
  return arguments.length >= 3 ? origReflectGet(target, key, receiver)
                                : origReflectGet(target, key);
};
```

Off by default because `Reflect.get` is hot in engine internals and
adds measurable overhead. Enable for high-coverage forensic runs.

## Anti-anti-debug (Phase 5)

A detector that wants to verify `navigator.webdriver` is not
instrumented will check:

```js
Function.prototype.toString.call(
  Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get,
).includes("[native code]");
```

We patch `Function.prototype.toString` to look up wrapped methods in a
`WeakMap` and return their stored original-source representation
(`"function get webdriver() { [native code] }"`) when the receiver is
one of our wrappers. Every wrap site (sinks, descriptor getters,
dynamic-exec, Worker constructor, etc.) registers through a single
`registerWrapper(wrapped, original)` helper — drift here is the #1
reason a detector spots our patches, so it's centralized. Forwarded
calls on un-wrapped functions go to the original `toString`.

CDP `Debugger.setSkipAllPauses(true)` is set on the driver side to
swallow `debugger` statement traps that try to detect that DevTools is
attached. Combined with the toString masking, this is enough for the
common detector libraries (DataDome, PerimeterX, Akamai BMP, Cloudflare
bot-management challenge); harder ones require timing-noise
flattening (also a Phase 5 deliverable, configurable).

## What we still leak

- **The Proxy itself is detectable** via
  `Object.getPrototypeOf(navigator) !== Navigator.prototype`. We could
  install a Proxy on `getPrototypeOf` too, but it's a cat-and-mouse
  rabbit hole; we report the detection rather than mask infinitely.
- **`Function.prototype.toString` on our wrappers leaks via length /
  byte-pattern**. We can match length but not arbitrary byte patterns.
  Same trade-off — report, don't mask infinitely.
- **Stack-trace shape** (line numbers shifted by injected code) is
  in principle detectable. We don't inject a measurable amount of
  surface area into the page's own stacks.
