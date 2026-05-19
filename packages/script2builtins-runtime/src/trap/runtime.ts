/**
 * The in-page trap script.
 *
 * This file is NOT imported at runtime by browser code. The runtime
 * package stringifies `trapMain` via `Function.prototype.toString` and
 * injects the resulting source as a Playwright init script. So this
 * function must be:
 *
 *   - self-contained (every helper defined inside trapMain)
 *   - free of imports
 *   - free of TS-only syntax that doesn't compile to runnable JS
 *
 * The TS types here are *erased* by the compiler — they don't appear
 * in the stringified output. Lean on `any` where the browser DOM types
 * would force complexity that doesn't survive stringification.
 */

/** Config object injected into the stringified trap script as JSON. */
export interface TrapConfig {
  watchedRoots: string[];
  watchedPrototypes: string[];
  stackLimit: number;
  bufferByteCap: number;
  bodyPreviewLimit: number;
  evalSourceCap: number;
  evalRecursionDepth: number;
  channelName: string;
  trapDynamicExec: boolean;
  useProxyRoots: boolean;
  hardenIntrospection: boolean;
  /**
   * Optional: wrap `Reflect.get` so introspection trampolines that
   * bypass our Proxy roots still surface accesses to cataloged keys.
   * Off by default — engine internals call `Reflect.get` heavily and
   * wrapping it can break some pages.
   */
  trapReflectGet: boolean;
  /**
   * When true, wrap `Worker` / `SharedWorker` constructors to also
   * boot the trap inside the worker via `importScripts(<blob>)`. The
   * trap source for the worker is read from
   * `globalThis[config.workerTrapGlobalName]` (the driver writes it
   * via a sibling init script). Module workers (`{ type: "module" }`)
   * are skipped.
   */
  trapWorkers: boolean;
  /**
   * Name of the `globalThis` property where the driver publishes the
   * trap source for worker bootstrap. Randomized per build by
   * default (`__s2bwt_<6 hex>`); a stealth shim consults
   * `Session.workerTrapGlobalName` to avoid colliding with it.
   */
  workerTrapGlobalName: string;
  trapHash: string;
  version: string;
  verbose: boolean;
}

/**
 * Body of the trap script. Stringified and wrapped as an IIFE by
 * `buildTrapScript`.
 *
 * The function takes a config object so the builder can inject the
 * concrete watched-roots list, prototype list, and limits.
 */
/* istanbul ignore next */
/* c8 ignore next */
export function trapMain(config: TrapConfig): void {
  // ─── 1. Pristine reference snapshot ──────────────────────────────
  // Every line below this uses __$ instead of the (now mutable) globals.
  const __$ = {
    Object: Object,
    Reflect: Reflect,
    Proxy: Proxy,
    Function: Function,
    Error: Error,
    WeakMap: WeakMap,
    Map: Map,
    Set: Set,
    Array: Array,
    String: String,
    JSON: JSON,
    Headers: typeof Headers !== "undefined" ? Headers : null,
    FormData: typeof FormData !== "undefined" ? FormData : null,
    URLSearchParams: typeof URLSearchParams !== "undefined" ? URLSearchParams : null,
    Blob: typeof Blob !== "undefined" ? Blob : null,
    ArrayBuffer: ArrayBuffer,
    Uint8Array: Uint8Array,
    isView: ArrayBuffer.isView,
    Promise: Promise,
    defineProperty: Object.defineProperty,
    getOwnDescriptor: Object.getOwnPropertyDescriptor,
    getOwnNames: Object.getOwnPropertyNames,
    getPrototypeOf: Object.getPrototypeOf,
    perfNow: typeof performance !== "undefined" ? performance.now.bind(performance) : Date.now,
    fnApply: Function.prototype.apply,
    fnCall: Function.prototype.call,
    fnBind: Function.prototype.bind,
    fnToString: Function.prototype.toString,
    // Bind so later page tampering with Error.captureStackTrace (or
    // Function.prototype.bind) can't reroute the call. Snapshotted here
    // so getStack() never touches the live `Error` namespace beyond the
    // pristine reference.
    captureStackTrace:
      typeof (Error as any).captureStackTrace === "function"
        ? (Error as any).captureStackTrace.bind(Error)
        : null,
    consoleDebug: typeof console !== "undefined" && console.debug ? console.debug.bind(console) : () => {},
  };

  // Guard against double-injection (e.g. user manually included the script).
  const win: any = typeof window !== "undefined" ? window : globalThis;
  if (win[config.channelName]) return;

  /** Run a section; record any failure so the report can surface it later. */
  const sectionErrors: Array<{ section: string; error: string }> = [];
  function section(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e: any) {
      sectionErrors.push({ section: name, error: e && e.message ? e.message : String(e) });
    }
  }

  // ─── 2. Event buffer + limits ────────────────────────────────────
  const events: any[] = [];
  let seq = 0;
  let bytes = 0;
  let overflows = 0;
  // Per-kind drop counters. Knowing *what* was dropped tells the user
  // whether the cap chewed up access spam (low signal) or wiped out
  // sink events (high signal — likely missing exfiltration).
  const overflowsByKind: Record<string, number> = { access: 0, sink: 0, hazard: 0 };
  // D14: push-mode flush counters. When the driver-side Playwright
  // binding `<channelName>_push` is present, events are flushed to
  // Node before the byte cap forces drop-oldest. `pushFlushes` counts
  // how often the binding fired; `pushedEvents` counts how many events
  // it carried — both surface on the channel for observability.
  let pushFlushes = 0;
  let pushedEvents = 0;
  let evalDepth = 0;
  const wrapperToString: WeakMap<Function, string> = new __$.WeakMap();
  // Name of the optional Node-side push binding. Resolved lazily on
  // each push() because Playwright injects bindings asynchronously
  // after page construction — the function may not exist when the
  // first events fire.
  const pushBindingName = config.channelName + "_push";
  // Re-entrancy guard for tryFlushToBinding. If the binding's
  // serialization happens to hit a wrapped API (it shouldn't — the
  // Playwright-installed function uses internal channels — but
  // defensively guard so a recursive push() can't loop).
  let inPushFlush = false;

  function estimateSize(ev: any): number {
    // Rough estimate — exactness doesn't matter, the cap is a guard.
    let n = 240;
    if (ev.stack) n += ev.stack.length;
    if (ev.source) n += ev.source.length;
    if (ev.chain) n += ev.chain.length * 16;
    if (ev.url) n += ev.url.length;
    if (ev.body && ev.body.preview) n += ev.body.preview.length;
    return n;
  }

  /**
   * D14: drain `events` to the Node side via Playwright's exposeBinding
   * channel and clear the in-page buffer. Called from {@link push} when
   * the next event would push us over `bufferByteCap`. The driver
   * accumulates the events into its own list so a subsequent
   * `Session.report()` sees them. Returns true if anything was flushed.
   */
  function tryFlushToBinding(): boolean {
    if (inPushFlush) return false;
    if (events.length === 0) return false;
    const fn = (win as any)[pushBindingName];
    if (typeof fn !== "function") return false;
    inPushFlush = true;
    try {
      const batch = events.slice();
      // Fire-and-forget — the binding returns a Promise, but
      // Playwright's machinery copies the args synchronously before
      // the IPC, so it's safe to clear immediately. The Promise's
      // rejection (if any) is ignored intentionally; we don't want
      // instrumentation to surface errors to the page.
      try {
        const p = fn(batch);
        if (p && typeof p.then === "function") {
          p.then(function () { /* drained */ }, function () { /* swallow */ });
        }
      } catch { /* binding rejected synchronously — accept the loss */ }
      events.length = 0;
      bytes = 0;
      pushFlushes++;
      pushedEvents += batch.length;
      return true;
    } finally {
      inPushFlush = false;
    }
  }

  function push(ev: any): void {
    ev.seq = seq++;
    ev.t = __$.perfNow();
    if (!ev.stack) ev.stack = "";
    if (!ev.scriptUrl) ev.scriptUrl = null;
    if (!("scriptSha256" in ev)) ev.scriptSha256 = null;
    if (!("line" in ev)) ev.line = null;
    if (!("column" in ev)) ev.column = null;
    const size = estimateSize(ev);
    if (bytes + size > config.bufferByteCap) {
      // Push-mode rotation (D14): try the Node-side binding first. On
      // success the buffer is empty and the new event fits; on failure
      // (binding not yet attached) we fall through to drop-oldest so
      // hot pages don't pile up unbounded.
      if (!tryFlushToBinding()) {
        while (bytes + size > config.bufferByteCap && events.length > 0) {
          const dropped = events.shift();
          bytes -= estimateSize(dropped);
          overflows++;
          const k = dropped && typeof dropped.kind === "string" ? dropped.kind : "unknown";
          overflowsByKind[k] = (overflowsByKind[k] || 0) + 1;
        }
      }
    }
    events.push(ev);
    bytes += size;
    if (config.verbose) {
      __$.consoleDebug("[s2bRt]", ev.kind, ev.chain ? ev.chain.join(".") : ev.sinkKind || ev.hazardKind);
    }
  }

  // Re-entrancy guard for getStack. Reading `err.stack` shouldn't run JS
  // when prepareStackTrace is undefined, but if a future engine quirk
  // (or our own wrapper firing on a side-effect) re-enters getStack,
  // the inner call returns a quick un-masked stack instead of saving /
  // restoring prepareStackTrace a second time. That prevents a window
  // where the inner finally restores the page's prepareStackTrace
  // *before* the outer call is done reading, leaking our frames.
  let inGetStack = false;

  function getStack(skip: number): string {
    if (inGetStack) {
      const err = new __$.Error();
      const raw = err.stack || "";
      const lines = raw.split("\n").slice(skip, skip + config.stackLimit);
      return lines.join("\n");
    }
    inGetStack = true;
    const ErrorRef: any = __$.Error;
    // Snapshot the page's current prepareStackTrace. If a detector
    // installs one to harvest CallSite frames, neutralizing it for the
    // duration of our read makes our stack invisible to it.
    const prevPST = ErrorRef.prepareStackTrace;
    try {
      try { ErrorRef.prepareStackTrace = undefined; } catch {}
      if (__$.captureStackTrace) {
        // V8 path: captureStackTrace(holder, getStack) elides getStack
        // and everything below it from the stack. The stack we capture
        // therefore doesn't even mention the trap's frames — what we
        // store in the event buffer starts at the page-script caller.
        const holder: any = {};
        try { __$.captureStackTrace(holder, getStack); } catch {}
        const raw = (holder && typeof holder.stack === "string") ? holder.stack : "";
        // captureStackTrace already excluded our frame; ignore `skip`.
        const lines = raw.split("\n").slice(0, config.stackLimit + 1);
        return lines.join("\n");
      }
      // Non-V8 fallback (Firefox / WebKit): plain Error + skip arithmetic.
      const err = new __$.Error();
      const raw = err.stack || "";
      const lines = raw.split("\n").slice(skip, skip + config.stackLimit);
      return lines.join("\n");
    } finally {
      try { ErrorRef.prepareStackTrace = prevPST; } catch {}
      inGetStack = false;
    }
  }

  // ─── Install channel FIRST so it's always present, even if a section throws.
  const channel = {
    drain: function (since?: number): any[] {
      const out: any[] = [];
      const cutoff = typeof since === "number" ? since : -1;
      for (let i = 0; i < events.length; i++) {
        if (events[i].seq > cutoff) out.push(events[i]);
      }
      return out;
    },
    flush: function (): any[] {
      const all = events.slice();
      events.length = 0;
      bytes = 0;
      return all;
    },
    get cursor() { return seq - 1; },
    get bufferOverflows() { return overflows; },
    get bufferOverflowsByKind() {
      // Return a defensive shallow copy so a misbehaving page can't
      // poison the counters via aliased mutation.
      return {
        access: overflowsByKind.access || 0,
        sink: overflowsByKind.sink || 0,
        hazard: overflowsByKind.hazard || 0,
      };
    },
    get sectionErrors() { return sectionErrors.slice(); },
    /** D14: how many times tryFlushToBinding() pushed a batch. */
    get pushFlushes() { return pushFlushes; },
    /** D14: total events pushed via the binding (separate from drain). */
    get pushedEvents() { return pushedEvents; },
    /**
     * D14: detector for the Node side. Returns whether the page can see
     * the push binding right now. The driver uses this to decide
     * whether to expect push-mode events or a pull-only drain.
     */
    get pushBindingAttached() {
      return typeof (win as any)[pushBindingName] === "function";
    },
    /**
     * D14: explicit flush trigger for the driver. Lets `Session.report`
     * pull whatever's still buffered through the binding before
     * draining the residual via the channel — useful at shutdown to
     * make sure no events sit in the in-page buffer past detach().
     * Returns the number of events that were flushed.
     */
    flushToBinding(): number {
      const before = pushedEvents;
      tryFlushToBinding();
      return pushedEvents - before;
    },
    version: config.version,
    trapHash: config.trapHash,
  };
  try {
    __$.defineProperty(win, config.channelName, {
      value: channel,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    try { (win as any)[config.channelName] = channel; } catch {}
  }

  // Register a wrapped function so Function.prototype.toString returns
  // the original native source when probed. Centralized so every
  // wrapper site (sinks, descriptor getters, dynamic-exec, …) goes
  // through one code path — drift here is the #1 reason a detector
  // sees `function () { /* wrapper */ }` and trips.
  function registerWrapper(wrapped: Function, original: Function): Function {
    try {
      wrapperToString.set(wrapped, __$.fnCall.call(__$.fnToString, original));
    } catch {
      // toString on the original might throw for exotic objects (Proxy
      // without a `.toString` trap, for example). The page sees the
      // wrapper's default Function source in that case — acceptable.
    }
    return wrapped;
  }

  // ─── 3. Root Proxy wrappers ──────────────────────────────────────
  function wrapFn(chain: string[], fn: Function, boundThis: any): Function {
    const wrapped = function (this: any, ...args: any[]): any {
      const first = args[0];
      push({
        kind: "access",
        chain: chain.slice(),
        called: true,
        firstStringArg: typeof first === "string" ? first : null,
        via: "apply",
        stack: getStack(2),
      });
      const target = boundThis !== undefined ? boundThis : this;
      const result = __$.fnApply.call(fn, target, args);
      return wrapResultIfNeeded(chain, result);
    };
    return registerWrapper(wrapped as Function, fn);
  }

  function wrapResultIfNeeded(parentChain: string[], value: any): any {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object" && typeof value !== "function") return value;
    const ctor = value.constructor && value.constructor.name;
    if (
      ctor === "CanvasRenderingContext2D" ||
      ctor === "OffscreenCanvasRenderingContext2D" ||
      ctor === "WebGLRenderingContext" ||
      ctor === "WebGL2RenderingContext" ||
      ctor === "AudioContext" ||
      ctor === "OfflineAudioContext" ||
      ctor === "GPUAdapter" ||
      ctor === "GPUDevice"
    ) {
      return new __$.Proxy(value, {
        get(t: any, k: any, r: any) {
          if (typeof k !== "string") return __$.Reflect.get(t, k, r);
          const v = __$.Reflect.get(t, k, r);
          if (typeof v === "function") {
            return wrapFn(parentChain.concat([k]), v, t);
          }
          push({
            kind: "access",
            chain: parentChain.concat([k]),
            called: false,
            firstStringArg: null,
            via: "proxy",
            stack: getStack(1),
          });
          return v;
        },
      });
    }
    return value;
  }

  function proxyRoot(name: string): void {
    let target: any;
    try { target = win[name]; } catch { return; }
    if (target === undefined || target === null) return;
    // Only Proxy-wrap object-shaped roots.
    const ty = typeof target;
    if (ty !== "object" && ty !== "function") return;

    const proxy = new __$.Proxy(target, {
      get(t: any, k: any, _r: any) {
        if (typeof k !== "string") return __$.Reflect.get(t, k, t);
        let v: any;
        // Use the target as receiver so native getters that need a real
        // instance (e.g. navigator.userAgent) don't throw "Illegal
        // invocation". Standard JS super-semantics are not preserved by
        // this choice; that's an acceptable trade-off for instrumentation.
        try { v = __$.Reflect.get(t, k, t); }
        catch { try { v = __$.Reflect.get(t, k, _r); } catch { v = undefined; } }
        if (typeof v === "function") {
          return wrapFn([name, k], v, t);
        }
        push({
          kind: "access",
          chain: [name, k],
          called: false,
          firstStringArg: null,
          via: "proxy",
          stack: getStack(1),
        });
        return v;
      },
      has(t: any, k: any) {
        return __$.Reflect.has(t, k);
      },
    });
    try {
      __$.defineProperty(win, name, {
        get: function () { return proxy; },
        configurable: true,
      });
    } catch {
      // Non-configurable property — skip silently.
    }
  }

  section("proxy-roots", function () {
    if (!config.useProxyRoots) return;
    // Only Proxy a curated set of object-shaped globals. Proxy-wrapping
    // constructor functions violates the spec-required invariant for
    // non-configurable non-writable data properties (the constructor's
    // own `.prototype`). Proxy-wrapping `window` causes recursive
    // double-wrapping when other globals are accessed via window.X.
    const PROXY_SAFE = [
      "navigator", "screen", "document", "location", "history",
      "performance", "crypto", "chrome", "speechSynthesis",
      "indexedDB", "localStorage", "sessionStorage", "caches",
      "cookieStore", "Notification", "Intl",
    ];
    for (let i = 0; i < PROXY_SAFE.length; i++) {
      const r = PROXY_SAFE[i]!;
      if (config.watchedRoots.indexOf(r) !== -1) {
        try { proxyRoot(r); } catch (e: any) { sectionErrors.push({ section: "proxy-root:" + r, error: String(e && e.message) }); }
      }
    }
  });

  // ─── 4. Prototype descriptor patches ─────────────────────────────
  function resolveDotted(path: string): any {
    let cur: any = win;
    const parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      cur = cur && cur[parts[i]!];
      if (cur === undefined || cur === null) return null;
    }
    return cur;
  }

  function wrapProtoMethod(protoPath: string, methodName: string): void {
    const proto = resolveDotted(protoPath);
    if (!proto) return;
    let desc: PropertyDescriptor | undefined;
    try { desc = __$.getOwnDescriptor(proto, methodName); } catch { return; }
    if (!desc) return;
    const chain = ["*", methodName];

    if (typeof desc.value === "function") {
      const orig = desc.value;
      const wrapped = wrapFn(chain, orig, undefined);
      try {
        __$.defineProperty(proto, methodName, {
          value: wrapped,
          writable: desc.writable !== false,
          configurable: true,
          enumerable: desc.enumerable === true,
        });
      } catch {}
      return;
    }
    if (typeof desc.get === "function") {
      const origGet = desc.get;
      const wrappedGet = function (this: any) {
        push({
          kind: "access",
          chain: chain.slice(),
          called: false,
          firstStringArg: null,
          via: "descriptor",
          stack: getStack(1),
        });
        return __$.fnCall.call(origGet, this);
      };
      registerWrapper(wrappedGet as Function, origGet);
      try {
        __$.defineProperty(proto, methodName, {
          get: wrappedGet,
          set: desc.set,
          configurable: true,
          enumerable: desc.enumerable === true,
        });
      } catch {}
    }
  }

  section("proto-patches", function () {
    for (let i = 0; i < config.watchedPrototypes.length; i++) {
      const protoPath = config.watchedPrototypes[i]!;
      const proto = resolveDotted(protoPath);
      if (!proto) continue;
      let names: string[];
      try { names = __$.getOwnNames(proto); } catch { continue; }
      for (let j = 0; j < names.length; j++) {
        const n = names[j]!;
        if (n === "constructor") continue;
        try { wrapProtoMethod(protoPath, n); } catch {}
      }
    }
  });

  // ─── 5. Sink wrappers ────────────────────────────────────────────
  section("sinks", function () {
  function normalizeHeaders(h: any): Record<string, string> {
    const out: Record<string, string> = {};
    if (!h) return out;
    if (__$.Headers && h instanceof __$.Headers) {
      h.forEach(function (v: string, k: string) { out[k] = v; });
    } else if (__$.Array.isArray(h)) {
      for (let i = 0; i < h.length; i++) {
        const pair = h[i];
        if (pair && pair.length >= 2) out[__$.String(pair[0])] = __$.String(pair[1]);
      }
    } else if (typeof h === "object") {
      const keys = __$.Object.keys(h);
      for (let i = 0; i < keys.length; i++) out[keys[i]!] = __$.String(h[keys[i]!]);
    }
    return out;
  }

  function serializeBody(body: any): any {
    if (body === null || body === undefined) return null;
    if (typeof body === "string") {
      const truncated = body.length > config.bodyPreviewLimit;
      return { shape: "string", preview: truncated ? body.slice(0, config.bodyPreviewLimit) : body, truncated };
    }
    if (__$.FormData && body instanceof __$.FormData) {
      const entries: any[] = [];
      body.forEach(function (v: any, k: string) { entries.push([k, typeof v === "string" ? v : "[file]"]); });
      const preview = __$.JSON.stringify(entries);
      const truncated = preview.length > config.bodyPreviewLimit;
      return { shape: "formdata", preview: truncated ? preview.slice(0, config.bodyPreviewLimit) : preview, truncated };
    }
    if (__$.URLSearchParams && body instanceof __$.URLSearchParams) {
      const s = body.toString();
      const truncated = s.length > config.bodyPreviewLimit;
      return { shape: "urlsearchparams", preview: truncated ? s.slice(0, config.bodyPreviewLimit) : s, truncated };
    }
    if (__$.Blob && body instanceof __$.Blob) {
      return { shape: "blob", preview: "[Blob size=" + body.size + " type=" + body.type + "]", truncated: false };
    }
    if (body instanceof __$.ArrayBuffer || (__$.isView && __$.isView(body))) {
      const buf = body instanceof __$.ArrayBuffer ? new __$.Uint8Array(body) : new __$.Uint8Array((body as any).buffer);
      const cap = Math.min(buf.length, 256);
      let hex = "";
      for (let i = 0; i < cap; i++) {
        const h = buf[i]!.toString(16);
        hex += h.length === 1 ? "0" + h : h;
      }
      return { shape: "binary", preview: hex, truncated: buf.length > cap };
    }
    // Plain object / array — serialize via JSON. postMessage in particular
    // carries structured data that's already cloneable. fetch/xhr bodies
    // never legally land here (the spec coerces or rejects), so this is
    // safe to add to the shared path.
    if (typeof body === "object") {
      try {
        const j = __$.JSON.stringify(body);
        if (typeof j === "string") {
          const truncated = j.length > config.bodyPreviewLimit;
          return { shape: "json", preview: truncated ? j.slice(0, config.bodyPreviewLimit) : j, truncated };
        }
      } catch {
        // Cyclic / un-stringifiable — fall through to String(body).
      }
    }
    const s = __$.String(body);
    return { shape: "string", preview: s.slice(0, config.bodyPreviewLimit), truncated: s.length > config.bodyPreviewLimit };
  }

  // fetch
  if (typeof win.fetch === "function") {
    const origFetch = win.fetch;
    const wrappedFetch = function (this: any, input: any, init: any) {
      let url = "", method = "GET";
      try {
        if (typeof input === "string") { url = input; }
        else if (input && typeof input === "object") {
          url = input.url || "";
          method = input.method || "GET";
        }
        if (init && init.method) method = __$.String(init.method);
        method = method.toUpperCase();
        push({
          kind: "sink",
          sinkKind: "fetch",
          url,
          method,
          headers: normalizeHeaders(init && init.headers),
          body: init ? serializeBody(init.body) : null,
          stack: getStack(1),
        });
      } catch (e) { /* never let instrumentation break the page */ }
      return __$.fnApply.call(origFetch, this, arguments);
    };
    registerWrapper(wrappedFetch as Function, origFetch);
    try { win.fetch = wrappedFetch; } catch {}
  }

  // XMLHttpRequest
  if (typeof win.XMLHttpRequest === "function") {
    const XhrProto = win.XMLHttpRequest.prototype;
    const origOpen = XhrProto.open;
    const origSet = XhrProto.setRequestHeader;
    const origSend = XhrProto.send;
    const stateMap: WeakMap<any, any> = new __$.WeakMap();
    XhrProto.open = function (method: string, url: string) {
      try {
        stateMap.set(this, {
          method: __$.String(method).toUpperCase(),
          url: __$.String(url),
          headers: {} as Record<string, string>,
        });
      } catch {}
      return __$.fnApply.call(origOpen, this, arguments);
    };
    XhrProto.setRequestHeader = function (name: string, value: string) {
      try {
        const st = stateMap.get(this) || { headers: {} };
        st.headers[__$.String(name)] = __$.String(value);
        stateMap.set(this, st);
      } catch {}
      return __$.fnApply.call(origSet, this, arguments);
    };
    XhrProto.send = function (body: any) {
      try {
        const st = stateMap.get(this) || { method: "GET", url: "", headers: {} };
        push({
          kind: "sink",
          sinkKind: "xhr",
          url: st.url,
          method: st.method,
          headers: st.headers,
          body: serializeBody(body),
          stack: getStack(1),
        });
      } catch {}
      return __$.fnApply.call(origSend, this, arguments);
    };
    registerWrapper(XhrProto.open as Function, origOpen);
    registerWrapper(XhrProto.setRequestHeader as Function, origSet);
    registerWrapper(XhrProto.send as Function, origSend);
  }

  // navigator.sendBeacon (via prototype)
  if (typeof win.Navigator !== "undefined" && win.Navigator.prototype && typeof win.Navigator.prototype.sendBeacon === "function") {
    const origBeacon = win.Navigator.prototype.sendBeacon;
    win.Navigator.prototype.sendBeacon = function (url: any, body: any) {
      try {
        push({
          kind: "sink",
          sinkKind: "sendBeacon",
          url: __$.String(url),
          method: "POST",
          headers: {},
          body: serializeBody(body),
          stack: getStack(1),
        });
      } catch {}
      return __$.fnApply.call(origBeacon, this, arguments);
    };
    registerWrapper(win.Navigator.prototype.sendBeacon as Function, origBeacon);
  }

  // WebSocket
  if (typeof win.WebSocket === "function") {
    const OrigWs = win.WebSocket;
    const Wrapped: any = function (this: any, url: any, protocols: any) {
      try {
        push({
          kind: "sink",
          sinkKind: "websocket-open",
          url: __$.String(url),
          method: null,
          headers: {},
          body: null,
          stack: getStack(1),
        });
      } catch {}
      const ws = protocols === undefined ? new OrigWs(url) : new OrigWs(url, protocols);
      const origSend = ws.send.bind(ws);
      ws.send = function (data: any) {
        try {
          push({
            kind: "sink",
            sinkKind: "websocket-send",
            url: __$.String(url),
            method: null,
            headers: {},
            body: serializeBody(data),
            stack: getStack(1),
          });
        } catch {}
        return origSend(data);
      };
      return ws;
    };
    Wrapped.prototype = OrigWs.prototype;
    Wrapped.CONNECTING = OrigWs.CONNECTING;
    Wrapped.OPEN = OrigWs.OPEN;
    Wrapped.CLOSING = OrigWs.CLOSING;
    Wrapped.CLOSED = OrigWs.CLOSED;
    registerWrapper(Wrapped as Function, OrigWs);
    try { win.WebSocket = Wrapped; } catch {}
  }

  // EventSource: simple constructor wrap — no source to re-inject.
  if (typeof win.EventSource === "function") {
    const Orig = win.EventSource;
    const Wrapped: any = function (this: any, url: any, opts: any) {
      try {
        push({
          kind: "sink",
          sinkKind: "eventsource",
          url: __$.String(url),
          method: null,
          headers: {},
          body: null,
          stack: getStack(1),
        });
      } catch {}
      return opts === undefined ? new Orig(url) : new Orig(url, opts);
    };
    Wrapped.prototype = Orig.prototype;
    registerWrapper(Wrapped as Function, Orig);
    try { win.EventSource = Wrapped; } catch {}
  }

  // Worker / SharedWorker.
  //
  // When `trapWorkers` is on AND the driver wrote `__s2bWorkerTrap`
  // (the trap source as a string) to `globalThis`, we wrap classic
  // workers so each one boots the trap before the user script. The
  // trap re-runs in worker scope; its `typeof win.fetch === "function"`
  // guards mean DOM-only sections quietly no-op and network sinks
  // still get caught.
  //
  // Module workers ({ type: "module" }) and `SharedWorker` lookups
  // we can't rewrite (browser support gaps for blob importScripts in
  // shared workers) fall through to the original constructor with
  // only the sink event emitted.
  const workerCtors: Array<[string, string]> = [["Worker", "worker"], ["SharedWorker", "shared-worker"]];
  const URLCtor: any = (win as any).URL;
  const BlobCtor: any = (win as any).Blob;
  const workerTrapSource: string | undefined =
    config.trapWorkers && typeof (win as any)[config.workerTrapGlobalName] === "string"
      ? (win as any)[config.workerTrapGlobalName]
      : undefined;
  // Build the trap blob URL once and reuse across worker spawns.
  let workerTrapBlobUrl: string | null = null;
  if (workerTrapSource && URLCtor && BlobCtor) {
    try {
      const blob = new BlobCtor([workerTrapSource], { type: "application/javascript" });
      workerTrapBlobUrl = URLCtor.createObjectURL(blob);
    } catch { /* no-op; we'll fall through to the un-trapped path */ }
  }

  function canRewriteWorker(name: string): boolean {
    if (!workerTrapBlobUrl) return false;
    // SharedWorker bootstrap is browser-version sensitive (blob worker
    // scripts behave inconsistently on Safari / older Chromium). Track
    // as OOS-9 in the roadmap; fall through with only the sink event.
    if (name !== "Worker") return false;
    return true;
  }

  /**
   * Build a bootstrap blob URL for D3 module-worker support. Module
   * workers can't use `importScripts` (the function is only defined in
   * classic worker scope), so we emit a tiny ES module that statically
   * imports the trap source and then the user URL. Static imports run
   * before any top-level code in the module, and they evaluate in
   * declaration order — the trap installs itself, then the user
   * worker's module is loaded.
   *
   * The trap source is an IIFE expression statement, so loading it as
   * a module is just a side-effect import (no exports needed).
   */
  function buildModuleWorkerBoot(userUrl: string): string | null {
    if (!workerTrapBlobUrl || !BlobCtor || !URLCtor) return null;
    try {
      const bootSrc =
        "import " + __$.JSON.stringify(workerTrapBlobUrl) + ";\n" +
        "import " + __$.JSON.stringify(userUrl) + ";\n";
      const bootBlob = new BlobCtor([bootSrc], { type: "application/javascript" });
      return URLCtor.createObjectURL(bootBlob);
    } catch {
      return null;
    }
  }

  for (let i = 0; i < workerCtors.length; i++) {
    const name = workerCtors[i]![0]!;
    const kind = workerCtors[i]![1]!;
    if (typeof win[name] === "function") {
      const Orig = win[name];
      const Wrapped: any = function (this: any, url: any, opts: any) {
        try {
          push({
            kind: "sink",
            sinkKind: kind,
            url: __$.String(url),
            method: opts && opts.type === "module" ? "module" : "classic",
            headers: {},
            body: null,
            stack: getStack(1),
          });
        } catch {}
        if (canRewriteWorker(name)) {
          const userUrl = __$.String(url);
          const isModule = !!(opts && opts.type === "module");
          if (isModule) {
            // D3 path: ES-module bootstrap.
            const bootUrl = buildModuleWorkerBoot(userUrl);
            if (bootUrl) {
              try {
                return new Orig(bootUrl, opts);
              } catch { /* fall through */ }
            }
          } else {
            try {
              // Classic-worker bootstrap: importScripts(trap), then
              // importScripts(userUrl). Both calls are wrapped in
              // try/catch so a malformed URL doesn't kill the worker
              // before its real code runs.
              const bootSrc =
                "try { importScripts(" + __$.JSON.stringify(workerTrapBlobUrl) + "); } catch (e) {}\n" +
                "try { importScripts(" + __$.JSON.stringify(userUrl) + "); } catch (e) { throw e; }\n";
              const bootBlob = new BlobCtor([bootSrc], { type: "application/javascript" });
              const bootUrl = URLCtor.createObjectURL(bootBlob);
              return opts === undefined ? new Orig(bootUrl) : new Orig(bootUrl, opts);
            } catch { /* fall through to direct construction */ }
          }
        }
        return opts === undefined ? new Orig(url) : new Orig(url, opts);
      };
      Wrapped.prototype = Orig.prototype;
      registerWrapper(Wrapped as Function, Orig);
      try { win[name] = Wrapped; } catch {}
    }
  }

  // D4: ServiceWorker registration. Surfacing this as a sink lets
  // analysts see when a page tries to install a background script.
  // Trap-injection inside the SW is *not* attempted here — the spec
  // forbids `register()` from accepting blob: URLs, and a same-origin
  // wrapper would require the page to control its own server. Real
  // trap-side coverage of the worker scope is achievable through
  // CDP `ServiceWorker.inspectWorker` (driver-side); this in-page wrap
  // is the call-site half of that picture.
  if (
    (win as any).ServiceWorkerContainer &&
    (win as any).ServiceWorkerContainer.prototype &&
    typeof (win as any).ServiceWorkerContainer.prototype.register === "function"
  ) {
    const swProto = (win as any).ServiceWorkerContainer.prototype;
    const origRegister: any = swProto.register;
    const wrappedRegister = function (this: any, scriptUrl: any, opts: any) {
      try {
        const headers: Record<string, string> = {};
        if (opts && typeof opts === "object") {
          if (typeof opts.scope === "string") headers["scope"] = opts.scope;
          if (typeof opts.updateViaCache === "string") headers["updateViaCache"] = opts.updateViaCache;
        }
        push({
          kind: "sink",
          sinkKind: "service-worker",
          url: __$.String(scriptUrl),
          // We borrow `method` to carry the worker `type` (classic vs
          // module) — there's no native HTTP method on a SW register.
          // Downstream tooling already special-cases sink kinds; the
          // classic vs module distinction matters for analysts trying
          // to reason about which scripts run in worker scope.
          method: opts && opts.type === "module" ? "module" : "classic",
          headers,
          body: null,
          stack: getStack(1),
        });
      } catch { /* never break SW register */ }
      return __$.fnApply.call(origRegister, this, arguments);
    };
    try {
      __$.defineProperty(swProto, "register", {
        value: wrappedRegister,
        writable: true,
        configurable: true,
      });
      registerWrapper(wrappedRegister as Function, origRegister);
    } catch { /* property-redefine guard */ }
  }

  // image-src / script-src setters
  function wrapSrcSetter(CtorName: string, kind: string): void {
    const Ctor = win[CtorName];
    if (!Ctor || !Ctor.prototype) return;
    const desc = __$.getOwnDescriptor(Ctor.prototype, "src");
    if (!desc || typeof desc.set !== "function") return;
    const origSet = desc.set;
    const origGet = desc.get;
    try {
      __$.defineProperty(Ctor.prototype, "src", {
        configurable: true,
        get: origGet,
        set: function (value: any) {
          try {
            push({
              kind: "sink",
              sinkKind: kind,
              url: __$.String(value),
              method: null,
              headers: {},
              body: null,
              stack: getStack(1),
            });
          } catch {}
          return __$.fnCall.call(origSet, this, value);
        },
      });
    } catch {}
  }
  wrapSrcSetter("HTMLImageElement", "image-src");
  wrapSrcSetter("HTMLScriptElement", "script-src");

  // location.assign / location.replace
  try {
    const locProto = __$.getPrototypeOf(win.location);
    const navMethods = ["assign", "replace"];
    for (let i = 0; i < navMethods.length; i++) {
      const m = navMethods[i]!;
      const orig = locProto[m];
      if (typeof orig === "function") {
        const wrapped = function (this: any, url: any) {
          try {
            push({
              kind: "sink",
              sinkKind: "navigation",
              url: __$.String(url),
              method: null,
              headers: {},
              body: null,
              stack: getStack(1),
            });
          } catch {}
          return __$.fnCall.call(orig, this, url);
        };
        registerWrapper(wrapped as Function, orig);
        try { locProto[m] = wrapped; } catch {}
      }
    }
  } catch {}

  // importScripts (Worker-side only — no-op in main thread)
  if (typeof (win as any).importScripts === "function") {
    const orig = (win as any).importScripts;
    (win as any).importScripts = function () {
      for (let i = 0; i < arguments.length; i++) {
        try {
          push({
            kind: "sink",
            sinkKind: "importScripts",
            url: __$.String(arguments[i]),
            method: null,
            headers: {},
            body: null,
            stack: getStack(1),
          });
        } catch {}
      }
      return __$.fnApply.call(orig, this, arguments);
    };
  }

  // D7: postMessage on Window and MessagePort. Cross-realm sink — the
  // message doesn't hit the network but crosses an origin boundary,
  // a pattern used by detectors that fingerprint inside an isolated
  // iframe and exfiltrate to the embedder. Both targetOrigin (Window)
  // and channel-identity ("<MessagePort>") show up in the url slot so
  // downstream tooling can tell the two paths apart.
  function wrapPostMessage(proto: any, urlLabel: (this: any) => string): void {
    if (!proto) return;
    const orig: any = proto.postMessage;
    if (typeof orig !== "function") return;
    const desc = __$.Object.getOwnPropertyDescriptor(proto, "postMessage");
    // Some Web IDL bindings (notably Window.prototype.postMessage in
    // older Chromium) ship as non-configurable. Re-defining still works
    // when the property is writable; we fall back to a direct
    // assignment if defineProperty refuses.
    const wrapped = function (this: any) {
      try {
        const args = arguments;
        const data = args[0];
        let targetOrigin: string | null = null;
        const second = args[1];
        if (typeof second === "string") targetOrigin = second;
        else if (second && typeof second === "object" && typeof (second as any).targetOrigin === "string") {
          targetOrigin = (second as any).targetOrigin;
        }
        push({
          kind: "sink",
          sinkKind: "postmessage-send",
          // For Window: the targetOrigin (e.g. "*", "https://embedder.example").
          // For MessagePort: a stable label so analysts can group port traffic.
          url: targetOrigin !== null ? targetOrigin : urlLabel.call(this),
          method: null,
          headers: {},
          body: serializeBody(data),
          stack: getStack(1),
        });
      } catch { /* never let instrumentation break postMessage */ }
      return __$.fnApply.call(orig, this, arguments);
    };
    let installed = false;
    if (desc && desc.configurable) {
      try {
        __$.Object.defineProperty(proto, "postMessage", {
          value: wrapped,
          writable: desc.writable !== false,
          configurable: true,
          enumerable: desc.enumerable !== false,
        });
        installed = true;
      } catch { /* fall through */ }
    }
    if (!installed) {
      try {
        proto.postMessage = wrapped;
      } catch { /* property-redefine guard on locked-down builds */ }
    }
  }
  // Window.postMessage: patch the per-instance method on the global
  // directly. Going via Window.prototype is fragile because the proxy
  // root for `window` re-resolves through Reflect.get + wrapFn, which
  // can intercept the value before the prototype patch is consulted.
  // The direct assignment lets `window.postMessage(...)` call sites
  // hit our wrap regardless of how the lookup is structured.
  try {
    const origWin = (win as any).postMessage;
    if (typeof origWin === "function") {
      (win as any).postMessage = function (this: any) {
        try {
          const args = arguments;
          const data = args[0];
          let targetOrigin: string | null = null;
          const second = args[1];
          if (typeof second === "string") targetOrigin = second;
          else if (second && typeof second === "object" && typeof (second as any).targetOrigin === "string") {
            targetOrigin = (second as any).targetOrigin;
          }
          push({
            kind: "sink",
            sinkKind: "postmessage-send",
            url: targetOrigin !== null ? targetOrigin : "<Window>",
            method: null,
            headers: {},
            body: serializeBody(data),
            stack: getStack(1),
          });
        } catch { /* never break postMessage */ }
        return __$.fnApply.call(origWin, this, arguments);
      };
    }
  } catch { /* property-redefine guard */ }
  if ((win as any).MessagePort && (win as any).MessagePort.prototype) {
    wrapPostMessage((win as any).MessagePort.prototype, function () { return "<MessagePort>"; });
  }
  // Worker.prototype.postMessage and DedicatedWorkerGlobalScope.postMessage
  // (the worker-side `postMessage(...)` global) — both surface cross-realm
  // sends that detectors lean on.
  if ((win as any).Worker && (win as any).Worker.prototype) {
    wrapPostMessage((win as any).Worker.prototype, function () { return "<Worker>"; });
  }

  // D6: inbound message receivers. Symmetric to D7's outbound capture.
  // Detectors use WebSocket / EventSource / BroadcastChannel to receive
  // challenges, tokens, and instructions; capturing the payload lets
  // analysts understand the server side of the conversation without
  // running a network MITM.
  function wrapReceiver(
    proto: any,
    sinkKind: "websocket-message-recv" | "eventsource-message-recv" | "broadcastchannel-message-recv",
    urlFn: (this: any) => string,
  ): void {
    if (!proto) return;
    function makeListenerWrap(orig: Function): Function {
      return function (this: any, ev: any) {
        try {
          push({
            kind: "sink",
            sinkKind,
            url: urlFn.call(this),
            method: null,
            headers: {},
            body: serializeBody(ev && ev.data),
            stack: getStack(1),
          });
        } catch { /* never break delivery */ }
        return __$.fnApply.call(orig, this, arguments);
      };
    }

    // (a) addEventListener("message", fn, opts)
    const origAdd: any = proto.addEventListener;
    if (typeof origAdd === "function") {
      const wrappedAdd = function (this: any, type: any, listener: any, options?: any) {
        if (type === "message" && typeof listener === "function") {
          const wrappedListener = makeListenerWrap(listener);
          return __$.fnApply.call(origAdd, this, [type, wrappedListener, options]);
        }
        return __$.fnApply.call(origAdd, this, arguments);
      };
      try {
        proto.addEventListener = wrappedAdd;
      } catch { /* readonly proto on locked builds */ }
    }

    // (b) onmessage setter
    let dproto: any = proto;
    while (dproto && !__$.getOwnDescriptor(dproto, "onmessage")) {
      dproto = __$.getPrototypeOf(dproto);
    }
    if (dproto) {
      const desc = __$.getOwnDescriptor(dproto, "onmessage");
      if (desc && desc.configurable && typeof desc.set === "function" && typeof desc.get === "function") {
        const origSet = desc.set;
        const origGet = desc.get;
        try {
          __$.defineProperty(dproto, "onmessage", {
            configurable: true,
            enumerable: desc.enumerable !== false,
            get(this: any) {
              return origGet.call(this);
            },
            set(this: any, v: any) {
              if (typeof v === "function") {
                const wrapped = makeListenerWrap(v);
                origSet.call(this, wrapped);
              } else {
                origSet.call(this, v);
              }
            },
          });
        } catch { /* property-redefine guard */ }
      }
    }
  }
  if ((win as any).BroadcastChannel && (win as any).BroadcastChannel.prototype) {
    wrapReceiver(
      (win as any).BroadcastChannel.prototype,
      "broadcastchannel-message-recv",
      function (this: any) { return "broadcast:" + (this && this.name ? this.name : "?"); },
    );
  }
  if ((win as any).WebSocket && (win as any).WebSocket.prototype) {
    wrapReceiver(
      (win as any).WebSocket.prototype,
      "websocket-message-recv",
      function (this: any) { return (this && this.url) || "<WebSocket>"; },
    );
  }
  if ((win as any).EventSource && (win as any).EventSource.prototype) {
    wrapReceiver(
      (win as any).EventSource.prototype,
      "eventsource-message-recv",
      function (this: any) { return (this && this.url) || "<EventSource>"; },
    );
  }

  }); // end sinks
  // ─── 6. Dynamic-execution traps ──────────────────────────────────
  section("dynamic-exec", function () {
  function sha256Sync(input: string): string {
    // The trap doesn't have access to crypto.subtle (it's async). The
    // driver re-hashes on the Node side; we ship null and let it
    // backfill. This stub exists only to keep the property present.
    void input;
    return "";
  }

  if (config.trapDynamicExec) {
    const origEval = win.eval;
    const wrappedEval = function (src: any) {
      if (typeof src === "string") {
        try {
          push({
            kind: "hazard",
            hazardKind: "eval",
            source: src.length > config.evalSourceCap ? src.slice(0, config.evalSourceCap) : src,
            truncated: src.length > config.evalSourceCap,
            sha256: sha256Sync(src),
            stack: getStack(1),
          });
        } catch {}
      }
      if (evalDepth >= config.evalRecursionDepth) {
        return undefined;
      }
      evalDepth++;
      try { return origEval(src); } finally { evalDepth--; }
    };
    registerWrapper(wrappedEval as Function, origEval);
    try { win.eval = wrappedEval; } catch {}

    const OrigFn = win.Function;
    const WrappedFn: any = function (this: any, ...args: any[]) {
      try {
        if (args.length > 0) {
          const body = args[args.length - 1];
          if (typeof body === "string") {
            push({
              kind: "hazard",
              hazardKind: "Function",
              source: body.length > config.evalSourceCap ? body.slice(0, config.evalSourceCap) : body,
              truncated: body.length > config.evalSourceCap,
              sha256: sha256Sync(body),
              stack: getStack(1),
            });
          }
        }
      } catch {}
      // Reconstruct: new Function(...args) honors `this` only via construct.
      // Use Reflect.construct to faithfully delegate.
      return __$.Reflect.construct(OrigFn, args);
    };
    WrappedFn.prototype = OrigFn.prototype;
    registerWrapper(WrappedFn as Function, OrigFn);
    try { win.Function = WrappedFn; } catch {}

    const wrapStringTimer = function (name: string, kind: string): void {
      const orig = win[name];
      if (typeof orig !== "function") return;
      const wrapped = function (this: any, handler: any) {
        if (typeof handler === "string") {
          try {
            push({
              kind: "hazard",
              hazardKind: kind,
              source: handler.length > config.evalSourceCap ? handler.slice(0, config.evalSourceCap) : handler,
              truncated: handler.length > config.evalSourceCap,
              sha256: sha256Sync(handler),
              stack: getStack(1),
            });
          } catch {}
        }
        return __$.fnApply.call(orig, this, arguments);
      };
      registerWrapper(wrapped as Function, orig);
      try { win[name] = wrapped; } catch {}
    };
    wrapStringTimer("setTimeout", "setTimeout-string");
    wrapStringTimer("setInterval", "setInterval-string");
  }

  }); // end dynamic-exec
  // ─── 6b. SubtleCrypto (D8) ───────────────────────────────────────
  // Detectors hash fingerprint payloads before exfiltration to obscure
  // them in transit. Wrapping digest / sign surfaces (algorithm, input
  // length, input prefix) so an analyst can cross-walk hash outputs
  // back to the source bytes.
  section("subtle-crypto", function () {
    const subtle: any = win.crypto && (win.crypto as any).subtle;
    if (!subtle) return;

    function bytesOf(input: any): { len: number; preview: string } {
      // BufferSource: ArrayBuffer or typed-array / DataView.
      let buf: any = null;
      if (input instanceof __$.ArrayBuffer) {
        buf = new __$.Uint8Array(input);
      } else if (__$.isView && __$.isView(input)) {
        buf = new __$.Uint8Array((input as any).buffer, (input as any).byteOffset, (input as any).byteLength);
      } else if (typeof input === "string") {
        // Some sites pass a string. Encode as UTF-8 for byte length /
        // preview, but skip if TextEncoder isn't on the page (data:
        // origins should still have it; this is a paranoia guard).
        try {
          const enc = new (win as any).TextEncoder();
          buf = enc.encode(input);
        } catch { /* fall through */ }
      }
      if (!buf) return { len: 0, preview: "" };
      const cap = Math.min(buf.length, 64);
      let hex = "";
      for (let i = 0; i < cap; i++) {
        const h = buf[i]!.toString(16);
        hex += h.length === 1 ? "0" + h : h;
      }
      return { len: buf.length, preview: hex };
    }

    function algoName(a: any): string {
      if (typeof a === "string") return a;
      if (a && typeof a === "object" && typeof a.name === "string") return a.name;
      return __$.String(a);
    }

    if (typeof subtle.digest === "function") {
      const origDigest = subtle.digest;
      subtle.digest = function (this: any, algo: any, data: any) {
        try {
          const { len, preview } = bytesOf(data);
          push({
            kind: "crypto",
            op: "digest",
            algorithm: algoName(algo),
            inputByteLength: len,
            inputHexPreview: preview,
            stack: getStack(1),
          });
        } catch { /* never break crypto */ }
        return __$.fnApply.call(origDigest, this, arguments);
      };
    }

    if (typeof subtle.sign === "function") {
      const origSign = subtle.sign;
      subtle.sign = function (this: any, algo: any, _key: any, data: any) {
        try {
          const { len, preview } = bytesOf(data);
          push({
            kind: "crypto",
            op: "sign",
            algorithm: algoName(algo),
            inputByteLength: len,
            inputHexPreview: preview,
            stack: getStack(1),
          });
        } catch { /* never break crypto */ }
        return __$.fnApply.call(origSign, this, arguments);
      };
    }
  });

  // ─── 6c. WebAssembly module capture (D5) ─────────────────────────
  // Detectors increasingly ship logic in WASM because static
  // analysers don't reach into the bytecode. Wrap the four module
  // entry points so the bytes leave the page through our channel,
  // base64-encoded. Streaming variants peek the bytes via
  // Response.clone() so the original response stays unconsumed for
  // the real WebAssembly call.
  section("webassembly", function () {
    const WA: any = (win as any).WebAssembly;
    if (!WA) return;

    function bytesToB64(buf: Uint8Array): { b64: string; truncated: boolean } {
      // Base64-encode via btoa. btoa expects a binary string, so build
      // one chunk-at-a-time to avoid push-stack overflow on large
      // buffers (String.fromCharCode.apply with > ~100k args throws).
      const cap = Math.min(buf.length, config.evalSourceCap);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < cap; i += CHUNK) {
        const end = Math.min(i + CHUNK, cap);
        bin += __$.String.fromCharCode.apply(null, buf.subarray(i, end) as any);
      }
      let b64 = "";
      try { b64 = (win as any).btoa(bin); } catch { b64 = ""; }
      return { b64, truncated: buf.length > cap };
    }

    function toUint8(source: any): Uint8Array | null {
      if (source instanceof __$.ArrayBuffer) return new __$.Uint8Array(source);
      if (__$.isView && __$.isView(source)) {
        return new __$.Uint8Array((source as any).buffer, (source as any).byteOffset, (source as any).byteLength);
      }
      return null;
    }

    function emitWasm(
      op: "compile" | "compileStreaming" | "instantiate" | "instantiateStreaming",
      bytes: Uint8Array,
    ): void {
      const { b64, truncated } = bytesToB64(bytes);
      push({
        kind: "wasm",
        op,
        byteLength: bytes.length,
        bytesBase64: b64,
        truncated,
        sha256: "", // re-hashed Node-side
        stack: getStack(2),
      });
    }

    if (typeof WA.compile === "function") {
      const orig = WA.compile;
      WA.compile = function (source: any) {
        try {
          const u = toUint8(source);
          if (u) emitWasm("compile", u);
        } catch { /* never break wasm */ }
        return __$.fnApply.call(orig, this, arguments);
      };
    }

    if (typeof WA.instantiate === "function") {
      const orig = WA.instantiate;
      WA.instantiate = function (source: any) {
        try {
          // Skip the (Module, importObject) overload — those bytes
          // were already captured by compile.
          const u = toUint8(source);
          if (u) emitWasm("instantiate", u);
        } catch { /* never break wasm */ }
        return __$.fnApply.call(orig, this, arguments);
      };
    }

    // Streaming variants take a Response or Promise<Response>. We
    // wrap the source in a Promise that resolves to the same
    // Response, peeking the bytes via clone() in the meantime.
    function wrapStreaming(name: "compileStreaming" | "instantiateStreaming"): void {
      const orig = WA[name];
      if (typeof orig !== "function") return;
      WA[name] = function (source: any) {
        const peeked = __$.Promise.resolve(source).then(function (resp: any) {
          try {
            const cloned = resp && typeof resp.clone === "function" ? resp.clone() : null;
            if (cloned && typeof cloned.arrayBuffer === "function") {
              cloned.arrayBuffer().then(function (buf: ArrayBuffer) {
                try { emitWasm(name, new __$.Uint8Array(buf)); } catch {}
              }, function () { /* ignored */ });
            }
          } catch { /* ignored */ }
          return resp;
        });
        return __$.fnApply.call(orig, this, [peeked]);
      };
    }
    wrapStreaming("compileStreaming");
    wrapStreaming("instantiateStreaming");
  });

  // ─── 7. Reflect / descriptor trampoline traps ────────────────────
  // Reflect.get is invoked by lots of engine internals; hijacking it
  // generates noise. Off by default. Detector-grade scripts that probe
  // through `Reflect.get` already surface via the Proxy-wrapped roots
  // because Proxy[[Get]] is reached either way. The opt-in path here
  // catches the residual case: a script that grabbed a pre-trap
  // reference to a real root (e.g. via Object.getOwnPropertyDescriptor
  // on `window`) and calls Reflect.get on it bypassing the Proxy.
  section("reflect-get", function () {
    if (!config.trapReflectGet) return;
    const RealReflect: any = __$.Reflect;
    const origReflectGet: any = RealReflect.get;
    if (typeof origReflectGet !== "function") return;

    // Build a watched-roots set on the trap side so the wrap can fast-
    // reject `Reflect.get(plainObj, "x")` without pushing an event.
    const watchedSet: Record<string, boolean> = {};
    for (let i = 0; i < config.watchedRoots.length; i++) {
      watchedSet[config.watchedRoots[i]!] = true;
    }
    // Resolve roots once so we can compare by identity in the trap.
    const watchedRootObjs: Array<{ name: string; obj: any }> = [];
    for (let i = 0; i < config.watchedRoots.length; i++) {
      const name = config.watchedRoots[i]!;
      let r: any;
      try { r = win[name]; } catch { continue; }
      if (r && (typeof r === "object" || typeof r === "function")) {
        watchedRootObjs.push({ name, obj: r });
      }
    }

    const wrappedReflectGet = function (target: any, key: any, receiver?: any): any {
      try {
        if (typeof key === "string" && target && (typeof target === "object" || typeof target === "function")) {
          let chainName: string | null = null;
          for (let i = 0; i < watchedRootObjs.length; i++) {
            // Compare by identity — the page may have a direct
            // reference to the underlying root, not our Proxy.
            if (watchedRootObjs[i]!.obj === target) {
              chainName = watchedRootObjs[i]!.name;
              break;
            }
          }
          if (chainName !== null) {
            push({
              kind: "access",
              chain: [chainName, key],
              called: false,
              firstStringArg: null,
              via: "reflect",
              stack: getStack(1),
            });
          }
        }
      } catch { /* never let instrumentation break Reflect.get */ }
      return arguments.length >= 3
        ? origReflectGet(target, key, receiver)
        : origReflectGet(target, key);
    };
    registerWrapper(wrappedReflectGet as Function, origReflectGet);
    try {
      __$.defineProperty(RealReflect, "get", {
        value: wrappedReflectGet,
        writable: true,
        configurable: true,
      });
    } catch {}
  });

  // ─── 8. Introspection mask ───────────────────────────────────────
  section("introspection-mask", function () {
  if (config.hardenIntrospection) {
    const origToString = __$.fnToString;
    // CreepJS-class probes (see `test/trap/anti-anti-debug.test.ts`):
    //   - `Function.toString.call(wrappedFn)` — handled because we
    //     dispatch on `this`, not on the caller.
    //   - `Object.getOwnPropertyDescriptor(Function.prototype, "toString").value`
    //     returns the wrapper; the page can stash and reuse it. Same
    //     dispatch path handles that — the descriptor's `.value` IS our
    //     function.
    //   - `Reflect.ownKeys(Function.prototype)` length: defineProperty
    //     on an existing key doesn't add a key, so the count is stable.
    //   - `Function.prototype.toString.length` must be 0. Concise
    //     methods with zero declared params satisfy this.
    //   - `Function.prototype.toString.name` must be `"toString"`.
    //     Concise method named `toString` gives that for free.
    //   - `Reflect.ownKeys(Function.prototype.toString)` must NOT
    //     include `"prototype"`. Regular function expressions DO have
    //     a non-configurable `prototype`; concise methods do NOT.
    //     That's why this is a method shorthand, not a `function () {}`.
    const wrappedToString = ({
      toString(this: any) {
        const original = wrapperToString.get(this);
        if (original !== undefined) return original;
        return __$.fnCall.call(origToString, this);
      },
    }).toString;
    try {
      __$.defineProperty(Function.prototype, "toString", {
        value: wrappedToString,
        writable: true,
        configurable: true,
        // `enumerable` deliberately omitted: defineProperty on an
        // existing property leaves unspecified attributes alone, so
        // toString stays `enumerable: false` like the native.
      });
    } catch {}
    // Self-mask the masker so `Function.prototype.toString.toString()`
    // also returns the native source.
    registerWrapper(wrappedToString as Function, origToString);
  }
  }); // end introspection-mask

  // (Channel was installed at the top so it survives section errors.)
}
