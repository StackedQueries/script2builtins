/**
 * F2 — anti-anti-debug probes.
 *
 * Every CreepJS-class probe a detector typically runs against the
 * patched `Function.prototype.toString` and the trap's stack reads
 * must return a native-shaped value after `buildTrapScript` is
 * installed.
 *
 * The probes live here (not in `build.test.ts`) so a future regression
 * shows up in a single file with a self-evident name — easy to point
 * a bug report at.
 */
import { describe, it, expect } from "vitest";
import { createContext, runInContext } from "node:vm";
import { buildTrapScript } from "../../src/trap/build.js";

/**
 * Load the trap into a fresh vm sandbox. Returns the sandbox object so
 * tests can drive runInContext against it directly.
 *
 * `extras` runs after `var window = globalThis;` but BEFORE the trap
 * source — use it to install fake globals the trap will wrap.
 */
function loadTrap(extras = "") {
  const { source } = buildTrapScript({
    channelName: "__s2bRt",
    useProxyRoots: false,
    trapDynamicExec: true,
    hardenIntrospection: true,
  });
  const ctx: any = createContext({});
  runInContext("var window = globalThis;", ctx);
  if (extras) runInContext(extras, ctx);
  runInContext(source, ctx);
  return ctx;
}

describe("anti-anti-debug — Function.prototype.toString shape", () => {
  it("has name === 'toString'", () => {
    const ctx = loadTrap();
    expect(runInContext("Function.prototype.toString.name", ctx)).toBe("toString");
  });

  it("has length === 0", () => {
    const ctx = loadTrap();
    expect(runInContext("Function.prototype.toString.length", ctx)).toBe(0);
  });

  it("has no own 'prototype' property (concise-method shape)", () => {
    const ctx = loadTrap();
    const keys = runInContext("Reflect.ownKeys(Function.prototype.toString)", ctx) as string[];
    expect(keys).not.toContain("prototype");
    expect(runInContext("Function.prototype.toString.prototype === undefined", ctx)).toBe(true);
  });

  it("is not constructible (matches native)", () => {
    const ctx = loadTrap();
    const threw = runInContext(
      "(() => { try { new Function.prototype.toString(); return false; } catch (e) { return true; } })()",
      ctx,
    );
    expect(threw).toBe(true);
  });

  it("leaves Reflect.ownKeys(Function.prototype) unchanged by the patch", () => {
    // Function.prototype has Symbol keys (Symbol.hasInstance) so we
    // stringify each key before sorting.
    const probe =
      "Reflect.ownKeys(Function.prototype).map(k => typeof k === 'symbol' ? 'sym:' + (k.description || k.toString()) : k).sort()";

    const baseline: any = createContext({});
    runInContext("var window = globalThis;", baseline);
    const baselineKeys = runInContext(probe, baseline) as string[];

    const trapped = loadTrap();
    const trappedKeys = runInContext(probe, trapped) as string[];

    expect(trappedKeys).toEqual(baselineKeys);
  });

  it("the property descriptor stays { writable: true, enumerable: false, configurable: true }", () => {
    const ctx = loadTrap();
    const d = runInContext(
      `(() => {
         const dd = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
         return { writable: dd.writable, enumerable: dd.enumerable, configurable: dd.configurable, hasValue: typeof dd.value === "function" };
       })()`,
      ctx,
    ) as Record<string, unknown>;
    expect(d).toEqual({ writable: true, enumerable: false, configurable: true, hasValue: true });
  });

  it("self-mask: Function.prototype.toString.toString() returns native source", () => {
    const ctx = loadTrap();
    const s = runInContext("Function.prototype.toString.toString()", ctx) as string;
    expect(s).toContain("[native code]");
    expect(s).not.toContain("wrapperToString");
    expect(s).not.toContain("original");
  });
});

describe("anti-anti-debug — wrapped-function source masking", () => {
  it("masks via Function.prototype.toString.call(wrappedFn)", () => {
    const ctx = loadTrap(
      "window.eval = function evalNativeStub() { /* [native code] */ };" +
        "window.__before = Function.prototype.toString.call(window.eval);",
    );
    const before = runInContext("window.__before", ctx) as string;
    const after = runInContext("Function.prototype.toString.call(window.eval)", ctx) as string;
    expect(after).toBe(before);
    expect(after).toContain("evalNativeStub");
    expect(after).not.toContain("hazardKind");
  });

  it("masks via descriptor extraction (Object.getOwnPropertyDescriptor(...).value.call(fn))", () => {
    const ctx = loadTrap(
      "window.eval = function evalNativeStub() { /* [native code] */ };" +
        "window.__before = Function.prototype.toString.call(window.eval);",
    );
    const before = runInContext("window.__before", ctx) as string;
    const after = runInContext(
      `(() => {
         const dd = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
         return dd.value.call(window.eval);
       })()`,
      ctx,
    ) as string;
    expect(after).toBe(before);
  });

  it("returns the actual source for un-wrapped user functions", () => {
    const ctx = loadTrap();
    runInContext("function userFn(a, b) { return a + b; }", ctx);
    const s = runInContext("Function.prototype.toString.call(userFn)", ctx) as string;
    expect(s).toContain("userFn");
    expect(s).toContain("return a + b");
  });
});

describe("anti-anti-debug — getStack hides from page-installed prepareStackTrace", () => {
  it("never invokes Error.prepareStackTrace during a trapped read", () => {
    // Drive the trap with a wrapped path that ends up in getStack: the
    // dynamic-exec wrap on eval. Install a snooping prepareStackTrace
    // AFTER the trap is in place. If the trap forwards our frames to
    // the page-installed formatter, __pstCalls increments.
    const ctx = loadTrap();
    runInContext(
      `
      window.__pstCalls = 0;
      window.__lastSites = null;
      Error.prepareStackTrace = function (err, sites) {
        window.__pstCalls++;
        window.__lastSites = sites;
        return "fake";
      };
      `,
      ctx,
    );

    runInContext("eval('1+1');", ctx);

    expect(runInContext("window.__pstCalls", ctx)).toBe(0);
    expect(runInContext("window.__lastSites", ctx)).toBe(null);
  });

  it("restores the page's prepareStackTrace once getStack returns", () => {
    const ctx = loadTrap();
    runInContext(
      `
      window.__pstCalls = 0;
      Error.prepareStackTrace = function () { window.__pstCalls++; return "fake"; };
      `,
      ctx,
    );

    runInContext("eval('1+1');", ctx);

    // Identity: still the same function reference we installed.
    expect(runInContext("typeof Error.prepareStackTrace", ctx)).toBe("function");
    // Effect: a fresh page-side .stack read fires our installed formatter.
    runInContext("void new Error().stack;", ctx);
    expect(Number(runInContext("window.__pstCalls", ctx))).toBeGreaterThan(0);
  });

  it("survives nested wrapped calls without leaving prepareStackTrace neutralized", () => {
    // Re-entrancy guard sanity: after a chain of wrapped calls, the
    // page's prepareStackTrace must still fire on a subsequent user
    // .stack read. Drive two wrapped sinks back-to-back to exercise it.
    const ctx = loadTrap();
    runInContext(
      `
      window.__pstCalls = 0;
      Error.prepareStackTrace = function () { window.__pstCalls++; return "fake"; };
      `,
      ctx,
    );

    runInContext("eval('1+1'); eval('2+2'); new Function('return 1')();", ctx);

    // Zero calls during the trap path.
    expect(runInContext("window.__pstCalls", ctx)).toBe(0);
    // Non-zero calls once the user reads .stack again.
    runInContext("void new Error().stack;", ctx);
    expect(Number(runInContext("window.__pstCalls", ctx))).toBeGreaterThan(0);
  });
});
