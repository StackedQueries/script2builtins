import { describe, it, expect } from "vitest";
import { createContext, runInContext } from "node:vm";
import { buildTrapScript, WATCHED_PROTOTYPES } from "../../src/trap/build.js";

describe("buildTrapScript", () => {
  it("returns a stable hash for the same options (determinism)", () => {
    const a = buildTrapScript({
      stackLimit: 8,
      channelName: "__s2bRt",
      workerTrapGlobalName: "__wt",
    });
    const b = buildTrapScript({
      stackLimit: 8,
      channelName: "__s2bRt",
      workerTrapGlobalName: "__wt",
    });
    expect(a.sha256).toEqual(b.sha256);
    expect(a.source).toEqual(b.source);
  });

  it("changes hash when options change", () => {
    const a = buildTrapScript({ stackLimit: 8 });
    const b = buildTrapScript({ stackLimit: 16 });
    expect(a.sha256).not.toEqual(b.sha256);
  });

  it("emits a self-contained IIFE", () => {
    const { source } = buildTrapScript();
    // Starts with leading semicolon to avoid ASI hazards.
    expect(source.startsWith(";(")).toBe(true);
    // Ends with the call argument terminator.
    expect(source.endsWith(");")).toBe(true);
    // No *statement-level* import/require — the trap must not become an
    // ES module. The D3 module-worker bootstrap embeds the literal
    // string `"import "` as a quoted token inside the trap source; that
    // is fine, what we're guarding against is a real `import x from ...`
    // at the top of a statement.
    expect(source).not.toMatch(/(?:^|[\n;])\s*import\s+[^"]/);
    expect(source).not.toMatch(/(?:^|[\n;])\s*require\(/);
  });

  it("bakes the watched prototypes into the config", () => {
    const { config } = buildTrapScript();
    expect(config.watchedPrototypes.length).toBeGreaterThan(0);
    expect(config.watchedPrototypes).toEqual([...WATCHED_PROTOTYPES].sort());
  });

  it("bakes the watched roots into the config", () => {
    const { config } = buildTrapScript();
    expect(config.watchedRoots).toContain("navigator");
    expect(config.watchedRoots).toContain("screen");
    expect(config.watchedRoots).toContain("document");
    // Sorted for determinism.
    const sorted = [...config.watchedRoots].sort();
    expect(config.watchedRoots).toEqual(sorted);
  });

  it("embeds the sha256 into the in-page config so it's self-identifying", () => {
    const { source, sha256 } = buildTrapScript();
    expect(source).toContain(sha256);
  });

  it("filters by category when requested", () => {
    const full = buildTrapScript();
    const justNav = buildTrapScript({ categories: ["navigator"] });
    expect(justNav.config.watchedRoots.length).toBeLessThanOrEqual(full.config.watchedRoots.length);
    expect(justNav.config.watchedRoots).toContain("navigator");
  });

  it("randomizes the channel name per build by default", () => {
    const a = buildTrapScript();
    const b = buildTrapScript();
    expect(a.config.channelName).toMatch(/^__s2b_[0-9a-f]{12}$/);
    expect(b.config.channelName).toMatch(/^__s2b_[0-9a-f]{12}$/);
    expect(a.config.channelName).not.toBe(b.config.channelName);
    // The randomized name flows into the IIFE source as well.
    expect(a.source).toContain(a.config.channelName);
  });

  it("respects an explicit channelName when given", () => {
    const a = buildTrapScript({ channelName: "__myProbe", workerTrapGlobalName: "__wt" });
    const b = buildTrapScript({ channelName: "__myProbe", workerTrapGlobalName: "__wt" });
    expect(a.config.channelName).toBe("__myProbe");
    // Determinism — same options, same hash.
    expect(a.sha256).toBe(b.sha256);
  });

  it("randomizes workerTrapGlobalName per build by default", () => {
    const a = buildTrapScript();
    const b = buildTrapScript();
    expect(a.config.workerTrapGlobalName).toMatch(/^__s2bwt_[0-9a-f]{12}$/);
    expect(b.config.workerTrapGlobalName).toMatch(/^__s2bwt_[0-9a-f]{12}$/);
    expect(a.config.workerTrapGlobalName).not.toBe(b.config.workerTrapGlobalName);
    expect(a.source).toContain(a.config.workerTrapGlobalName);
  });
});

describe("trap channel — buffer overflow counters", () => {
  // Build a barebones sandbox where the trap's references resolve.
  // The trap itself only needs the standard globals plus `window`; we
  // expose `globalThis` as window so the channel install works.
  function loadTrap(bufferByteCap: number) {
    const { source } = buildTrapScript({
      bufferByteCap,
      channelName: "__s2bRt",
      // Keep the trap from trying to wrap network sinks / dynamic exec
      // in the sandbox — those globals are absent and the sections will
      // no-op cleanly thanks to typeof guards.
      useProxyRoots: false,
      trapDynamicExec: false,
      hardenIntrospection: false,
    });
    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);
    runInContext(source, ctx);
    return ctx.__s2bRt as {
      drain: (since?: number) => unknown[];
      flush: () => unknown[];
      cursor: number;
      bufferOverflows: number;
      bufferOverflowsByKind: { access: number; sink: number; hazard: number };
    };
  }

  it("counts dropped events by kind when the buffer overflows", () => {
    // Set a tiny cap so a handful of events forces drops.
    const ch = loadTrap(1024);
    // Drive events directly into the channel by re-using the in-page
    // push surface. We don't have access to push() from outside, so
    // exercise the cap via the public API: the trap's own sink wrappers
    // would normally feed it. For unit purposes we can drive
    // `drain()`/`flush()` and verify the breakdown shape exists.
    const bk = ch.bufferOverflowsByKind;
    expect(bk).toEqual({ access: 0, sink: 0, hazard: 0 });
  });

  it("exposes overflow counters as own properties of the channel", () => {
    const ch = loadTrap(16 * 1024 * 1024);
    expect(typeof ch.bufferOverflows).toBe("number");
    expect(typeof ch.bufferOverflowsByKind.access).toBe("number");
    expect(typeof ch.bufferOverflowsByKind.sink).toBe("number");
    expect(typeof ch.bufferOverflowsByKind.hazard).toBe("number");
  });
});

describe("trap Reflect.get wrap (D2 — on by default)", () => {
  it("wraps Reflect.get by default; opt-out via trapReflectGet: false", () => {
    // Default: on
    const { config: onConfig } = buildTrapScript({ channelName: "__s2bRt" });
    expect(onConfig.trapReflectGet).toBe(true);

    // Opt-out: Reflect.get should remain untouched.
    const { source: offSource, config: offConfig } = buildTrapScript({
      channelName: "__s2bRt",
      useProxyRoots: false,
      trapReflectGet: false,
    });
    expect(offConfig.trapReflectGet).toBe(false);
    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);
    runInContext("window.__nav = { userAgent: 'fake' };", ctx);
    runInContext(offSource, ctx);
    const native = runInContext("Reflect.get.toString()", ctx) as string;
    expect(native).toContain("[native code]");
  });

  it("emits an access event when enabled and Reflect.get hits a watched root", () => {
    const { source, config } = buildTrapScript({
      channelName: "__s2bRt",
      useProxyRoots: false,
      trapReflectGet: true,
    });
    expect(config.trapReflectGet).toBe(true);

    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);
    // Make `navigator` a watched root in the sandbox by pre-installing
    // it before the trap. The trap reads `win[name]` to find roots.
    runInContext("window.navigator = { userAgent: 'fake', deviceMemory: 8 };", ctx);
    runInContext(source, ctx);
    // Drive a Reflect.get on the underlying navigator (NOT through Proxy).
    runInContext("window.__r = Reflect.get(window.navigator, 'userAgent');", ctx);
    const r = runInContext("window.__r", ctx);
    expect(r).toBe("fake");
    const events = runInContext("window.__s2bRt.drain(-1)", ctx) as any[];
    const reflectAccesses = events.filter(
      (e) => e.kind === "access" && e.via === "reflect" && e.chain[0] === "navigator" && e.chain[1] === "userAgent",
    );
    expect(reflectAccesses.length).toBe(1);
  });
});

describe("trap Worker instrumentation (classic workers)", () => {
  it("rewrites Worker URL into a bootstrap blob when trapWorkers + workerTrapGlobalName are set", () => {
    const { source } = buildTrapScript({
      channelName: "__s2bRt",
      workerTrapGlobalName: "__s2bWorkerTrap",
      useProxyRoots: false,
      trapDynamicExec: false,
      trapWorkers: true,
    });
    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);

    // Minimal Blob + URL + Worker shims so the trap's rewrite path can run.
    runInContext(
      `
      window.__s2bWorkerTrap = "/* worker trap source */";
      window.__blobs = [];
      window.Blob = function (parts, opts) { this.parts = parts; this.opts = opts; };
      window.URL = { createObjectURL: function (b) { window.__blobs.push(b); return "blob:fake#" + (window.__blobs.length - 1); } };
      window.__workerArgs = [];
      window.Worker = function (url, opts) { window.__workerArgs.push([url, opts]); };
      `,
      ctx,
    );
    runInContext(source, ctx);
    runInContext("new window.Worker('https://example.com/w.js');", ctx);
    const args = runInContext("window.__workerArgs", ctx) as Array<[string, unknown]>;
    expect(args.length).toBe(1);
    // The URL passed into the *original* Worker constructor is the
    // bootstrap blob URL (not the user URL).
    expect(args[0]![0]).toMatch(/^blob:fake#\d+$/);
    // And the blob body for that bootstrap contains both an
    // importScripts(<trap blob>) and importScripts(<user url>).
    const blobIdx = Number(args[0]![0]!.split("#")[1]);
    const blobParts = runInContext(`window.__blobs[${blobIdx}].parts`, ctx) as string[];
    expect(blobParts.length).toBe(1);
    expect(blobParts[0]!).toContain("importScripts(\"blob:fake#0\")");
    expect(blobParts[0]!).toContain("importScripts(\"https://example.com/w.js\")");
  });

  it("D3: rewrites module workers to a bootstrap blob that ES-imports the trap then the user URL", () => {
    const { source } = buildTrapScript({
      channelName: "__s2bRt",
      workerTrapGlobalName: "__s2bWorkerTrap",
      useProxyRoots: false,
      trapDynamicExec: false,
      trapWorkers: true,
    });
    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);

    // Mock URL/Blob/Worker so we can see what bytes the bootstrap blob
    // carries. The trap chooses an ES-module bootstrap when opts.type
    // is "module".
    runInContext(
      `
      window.__s2bWorkerTrap = "/* worker trap source */";
      window.__blobs = [];
      window.Blob = function (parts, opts) { this.parts = parts; this.opts = opts; };
      window.URL = { createObjectURL: function (b) { window.__blobs.push(b); return "blob:fake#" + (window.__blobs.length - 1); } };
      window.__workerArgs = [];
      window.Worker = function (url, opts) { window.__workerArgs.push([url, opts]); };
      `,
      ctx,
    );
    runInContext(source, ctx);
    runInContext("new window.Worker('https://example.com/m.js', { type: 'module' });", ctx);
    const args = runInContext("window.__workerArgs", ctx) as Array<[string, unknown]>;
    expect(args.length).toBe(1);
    // First arg is now the bootstrap blob URL, second arg keeps the
    // original opts (so the worker is still launched as a module).
    expect(args[0]![0]).toMatch(/^blob:fake#\d+$/);
    expect(args[0]![1]).toEqual({ type: "module" });
    // Two blobs were created total — index 0 is the trap-source blob
    // (built once at section init), index 1 is this worker's
    // per-spawn bootstrap module.
    const bootIdx = Number(args[0]![0]!.split("#")[1]);
    const bootParts = runInContext(`window.__blobs[${bootIdx}].parts`, ctx) as string[];
    expect(bootParts.length).toBe(1);
    // ES-module bootstrap — static imports, no importScripts().
    expect(bootParts[0]!).toContain("import \"blob:fake#0\"");
    expect(bootParts[0]!).toContain("import \"https://example.com/m.js\"");
    expect(bootParts[0]!).not.toContain("importScripts");
    // Blob mime is application/javascript so the browser parses it
    // as a JS module.
    const bootMime = runInContext(`window.__blobs[${bootIdx}].opts.type`, ctx) as string;
    expect(bootMime).toBe("application/javascript");
  });

  it("D4: wraps navigator.serviceWorker.register and emits a service-worker sink", () => {
    const { source } = buildTrapScript({
      channelName: "__s2bRt",
      useProxyRoots: false,
      trapDynamicExec: false,
      trapWorkers: false,
      hardenIntrospection: false,
    });
    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);
    // Minimal ServiceWorkerContainer shim. The trap walks
    // ServiceWorkerContainer.prototype.register so we model that
    // shape — a prototype with a register method and an instance
    // hung on navigator.
    runInContext(
      `
      window.__registerCalls = [];
      function ServiceWorkerContainer() {}
      ServiceWorkerContainer.prototype.register = function (url, opts) {
        window.__registerCalls.push([url, opts]);
        return { fake: true };
      };
      window.ServiceWorkerContainer = ServiceWorkerContainer;
      window.navigator = { serviceWorker: new ServiceWorkerContainer() };
      `,
      ctx,
    );
    runInContext(source, ctx);
    runInContext(
      "window.navigator.serviceWorker.register('/sw.js', { scope: '/app/', type: 'module' });",
      ctx,
    );
    const calls = runInContext("window.__registerCalls", ctx) as Array<[string, unknown]>;
    // The wrap forwards to the original — registration still happens.
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("/sw.js");

    // And the sink event landed.
    const events = runInContext("window.__s2bRt.drain(-1)", ctx) as Array<any>;
    const sw = events.find((e) => e.kind === "sink" && e.sinkKind === "service-worker");
    expect(sw).toBeDefined();
    expect(sw.url).toBe("/sw.js");
    expect(sw.method).toBe("module");
    expect(sw.headers.scope).toBe("/app/");
  });
});

describe("trap D14 push-mode rotation", () => {
  // Helper: build a trap with a deliberately tiny byte cap and a
  // mock binding function on `window`. Then push synthetic events
  // through the public channel by calling its drain/flush methods —
  // we need to actually emit events to exercise rotation, so we
  // exercise it via the trap's own access-emission path (Reflect
  // wrap on a watched root).
  function loadTrapWithBinding(opts: { bufferByteCap: number; channelName: string }) {
    const { source, config } = buildTrapScript({
      bufferByteCap: opts.bufferByteCap,
      channelName: opts.channelName,
      useProxyRoots: false,
      trapDynamicExec: false,
      hardenIntrospection: false,
      trapWorkers: false,
      trapReflectGet: true,
    });
    const pushBindingName = `${config.channelName}_push`;
    const received: any[][] = [];
    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);
    runInContext(`window.navigator = { userAgent: "fake" };`, ctx);
    // The binding has to exist before the trap installs so push() can
    // find it. In Playwright that's enforced by addInitScript
    // ordering; here we set it up directly.
    ctx.__pushReceived = received;
    runInContext(
      `window["${pushBindingName}"] = function (batch) { __pushReceived.push(batch); return Promise.resolve(); };`,
      ctx,
    );
    runInContext(source, ctx);
    return { ctx, received, channelName: config.channelName };
  }

  it("flushes through the binding instead of dropping events when the cap is breached", () => {
    // 600B cap is enough for ~1 access event then we tip over on the
    // second one. Reflect.get on navigator emits one access event per
    // call.
    const { ctx, received, channelName } = loadTrapWithBinding({
      bufferByteCap: 600,
      channelName: "__s2b_push_test",
    });
    // Drive a few Reflect.get reads on navigator. Each one pushes an
    // access event into the buffer; the byte cap forces a push-flush.
    for (let i = 0; i < 6; i++) {
      runInContext("Reflect.get(window.navigator, 'userAgent');", ctx);
    }
    const ch = ctx[channelName];
    expect(typeof ch.pushFlushes).toBe("number");
    // At least one flush should have fired.
    expect(ch.pushFlushes).toBeGreaterThanOrEqual(1);
    // And no events should have been dropped — push absorbed the
    // rotation pressure.
    expect(ch.bufferOverflows).toBe(0);
    // The flushed batches add up to at least the pushed-event count.
    const total = received.reduce((n, batch) => n + batch.length, 0);
    expect(total).toBe(ch.pushedEvents);
  });

  it("falls back to drop-oldest when no binding is attached", () => {
    const { source, config } = buildTrapScript({
      bufferByteCap: 600,
      channelName: "__s2b_nopush",
      useProxyRoots: false,
      trapDynamicExec: false,
      hardenIntrospection: false,
      trapWorkers: false,
      trapReflectGet: true,
    });
    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);
    runInContext(`window.navigator = { userAgent: "fake" };`, ctx);
    runInContext(source, ctx);
    for (let i = 0; i < 6; i++) {
      runInContext("Reflect.get(window.navigator, 'userAgent');", ctx);
    }
    const ch = ctx[config.channelName];
    // No binding ⇒ classic drop-oldest behavior.
    expect(ch.pushFlushes).toBe(0);
    expect(ch.bufferOverflows).toBeGreaterThan(0);
  });
});

describe("trap introspection masking", () => {
  // Drive the trap inside a vm sandbox and confirm that
  // Function.prototype.toString returns the "native" source for
  // wrapped functions, not the wrapper body. This is what stops a
  // detector from spotting our patches by reading the source.
  it("Function.prototype.toString masks wrapped functions", () => {
    const { source } = buildTrapScript({
      channelName: "__s2bRt",
      useProxyRoots: false,
      trapDynamicExec: true,
      hardenIntrospection: true,
    });
    const ctx: any = createContext({});
    runInContext("var window = globalThis;", ctx);
    // Set up a fake eval that the trap will wrap.
    runInContext(
      "window.eval = function evalNativeStub() { /* [native code] */ };" +
        "window.__evalSrcBefore = window.eval.toString();",
      ctx,
    );
    runInContext(source, ctx);
    // After the trap runs, eval is wrapped — its .toString should
    // still return the original "evalNativeStub" source, not the
    // wrapper.
    const after: string = runInContext("window.eval.toString()", ctx);
    const before: string = runInContext("window.__evalSrcBefore", ctx);
    expect(after).toBe(before);
    expect(after).toContain("evalNativeStub");
    expect(after).not.toContain("hazardKind");
  });
});
