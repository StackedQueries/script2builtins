---
title: Architecture
nav_order: 2
---

# Architecture

The pipeline has four moving parts. Each part has one job, and the
seam between them is the structured event stream emitted by the
in-page trap script.

```
   ┌────────────────────┐    addInitScript    ┌─────────────────────┐
   │  Node-side driver  │ ───────────────────▶│  Trap script (DOM)  │
   │  (Playwright +     │                     │                     │
   │  CDP)              │ ◀─────── events ────│  - root proxies     │
   │                    │     drain channel   │  - sink wrappers    │
   │  - launch Chromium │                     │  - eval/Function    │
   │  - addInitScript   │                     │  - introspection    │
   │  - capture every   │                     │    masking          │
   │    network JS      │                     └─────────────────────┘
   │  - drain events    │
   └────────┬───────────┘
            │
            │ for every captured JS:
            ▼
   ┌────────────────────┐
   │  script2builtins   │
   │  (static analyzer) │
   │                    │
   │  - parse           │
   │  - walkProgram     │
   │  - matchAccesses   │
   │  - scanSinks       │
   └────────┬───────────┘
            │
            │ ┌────────────┐
            │ │ runtime    │
            │ │ events →   │
            │ │ RawAccess[]│
            │ │ NetworkSink│
            └─┤            ├──────┐
              └────────────┘      │
                                  ▼
                       ┌────────────────────┐
                       │  Report merger     │
                       │                    │
                       │  union by api.key  │
                       │  provenance tag    │
                       │  gap report        │
                       │  (static-only /    │
                       │   runtime-only)    │
                       └────────────────────┘
```

## Trap script

A single self-contained string, generated from `ALL_APIS` and
`watchedRoots()` at build time. No external deps inside it. Lives in
[`src/trap/build.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins-runtime/src/trap/build.ts).

Generation is deliberate: every entry in the static catalog produces a
corresponding trap in the runtime layer. When you add a navigator
property to `packages/script2builtins-knowledge/src/navigator.ts`, you
get a runtime trap for free on the next build of
`script2builtins-runtime`.

The trap script does seven things:

1. **Snapshot pristine references.** Before any page script runs, hold
   references to `Object`, `Reflect`, `Proxy`, `Function.prototype.call`,
   `console`, etc. into a closure. These are the references the trap
   code uses internally — if the page replaces `window.Object`, our
   instrumentation still works.
2. **Install root proxies.** Each `watchedRoots()` member gets wrapped
   in a `Proxy` whose `get` / `has` / `apply` / `construct` traps emit
   events. Property descriptors on `navigator`, `screen`, `document`,
   `HTMLCanvasElement.prototype`, etc. are reinstalled to fire on
   access. (See [Trap internals](trap-internals.html).)
3. **Wrap sinks.** Each `NetworkSinkKind` becomes one or two wrappers
   around the global or prototype method. `fetch`, `XMLHttpRequest`
   `open`/`setRequestHeader`/`send`, `navigator.sendBeacon`,
   `WebSocket` constructor + `send`, etc.
4. **Trap dynamic execution.** `eval`, `Function`, `setTimeout`/
   `setInterval` (string form), and `import()` capture their source
   string before delegating to the original. The string is shipped
   out and recursively analyzed.
5. **Bootstrap workers** (when `trapWorkers: true`). Classic
   `new Worker(url)` is rewritten to construct a small bootstrap blob:
   `importScripts(<trap blob>); importScripts(<original url>);`. The
   trap source is published by the driver as
   `globalThis.__s2bWorkerTrap`. Module workers and `SharedWorker` are
   passed through (see [Limits](limits.html)).
6. **Drain events.** All events are written into an in-page array
   that the driver reads back via `page.evaluate`. The drain channel
   is installed on `window` under a **random per-build name**
   (`__s2b_<6 hex bytes>` by default; `Session.channelName` exposes
   it). Buffer overflows are counted per kind (`access` / `sink` /
   `hazard`) and surfaced in the report.
7. **Mask itself.** `Function.prototype.toString` is patched so
   wrappers return their original-source representation when
   introspected. All wrapper registration sites route through one
   `registerWrapper(wrapped, original)` helper, so the mask is
   uniform.

Optional surfaces:

- **`trapReflectGet`** (default off) — also wraps `Reflect.get` so
  non-Proxy root references that bypass the `navigator`/`screen`/etc.
  Proxy still surface accesses. Off by default because engine
  internals call `Reflect.get` heavily.

## Driver

A Playwright harness in [`src/runner/driver.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins-runtime/src/runner/driver.ts):

- Launches Chromium with `bypassCSP: true` and a stable Chrome UA.
- Calls `addInitScript` **twice**: first to publish
  `globalThis.__s2bWorkerTrap = "<trap source>"` (so spawned classic
  workers can `importScripts` it), then to inject the trap IIFE
  itself.
- Hooks `context.on("requestfinished", ...)` to persist every
  network-loaded JS for static analysis.
- After idle, calls `page.evaluate(<channelName>)` to drain the
  event buffer.
- Pulls inline `<script>` contents AND `<iframe srcdoc=…>` bodies
  from every reachable frame; srcdoc bodies are pulled through
  `extractScriptBodies` (`<script>` tags only; `application/json` and
  `application/ld+json` are skipped). Captured srcdoc inline scripts
  appear as `acquisition: "srcdoc"`.
- For each captured JS, runs `script2builtins.analyze` and writes
  per-script reports next to the source.
- Reconstructs `RawAccess[]` and `NetworkSink[]` from runtime events,
  feeds them through the static `matchAccesses` so the same catalog
  resolves them. Runtime sinks have their body preview re-parsed
  through `parseRuntimeBody` so `payload.leakedApis` populates
  identically to the static path.

## Static / runtime merge

Two `Finding[]` lists exist after analysis: one from the static pass
of every captured script, one from the runtime event stream. The
merger groups by `api.key` and tags each finding with `provenance`:

| provenance        | meaning                                                  |
|-------------------|----------------------------------------------------------|
| `static`          | matched in source, never fired                           |
| `runtime`         | fired at runtime, no static evidence (eval-only, etc.)   |
| `static+runtime`  | both — the static prediction was correct                 |

The summary surfaces `runtimeOnlyKeys` and `staticOnlyKeys` so you
immediately see where the two paths disagree — usually the
runtime-only set is the eval blob the static pass missed, and the
static-only set is dead-code paths the live run didn't take.

## Where things live in the repo

```
src/
  types.ts            # shared event + report shapes
  trap/
    build.ts          # buildTrapScript() — generates the init script
    runtime.ts        # source of the trap script (templated into a string)
  runner/
    driver.ts         # Playwright + CDP harness
    collect.ts        # event drain + reconstruction
    merge.ts          # static + runtime → annotated findings
  report/
    text.ts           # renderRuntimeText()
docs/                  # this site
test/
  trap/                # in-page trap unit tests (jsdom or playwright unit)
  runner/              # end-to-end against local fixtures
```
