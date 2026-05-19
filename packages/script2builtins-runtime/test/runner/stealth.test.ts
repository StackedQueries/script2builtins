/**
 * Unit-level checks for the stealth shim (D9). We don't drive a real
 * browser here — the shim's source is built with `buildStealthScript`
 * and exercised inside a `node:vm` sandbox with the relevant surfaces
 * mocked. The integration story (real Playwright Chromium) is
 * documented in docs/stealth-mode.md.
 */
import { describe, it, expect } from "vitest";
import { createContext, runInContext } from "node:vm";
import { buildStealthScript } from "../../src/runner/stealth.js";

function setUpNav(): any {
  const ctx: any = createContext({});
  // Sandbox shim for the navigator surface the shim patches. We
  // mirror the shape Chromium ships: getters on Navigator.prototype,
  // an instance hung on `window.navigator`.
  runInContext(
    `
    var window = globalThis;
    function Navigator() {}
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true, enumerable: true,
      get: function () { return true; },
    });
    Object.defineProperty(Navigator.prototype, 'plugins', {
      configurable: true, enumerable: true,
      get: function () { return []; },
    });
    Object.defineProperty(Navigator.prototype, 'languages', {
      configurable: true, enumerable: true,
      get: function () { return []; },
    });
    Object.defineProperty(Navigator.prototype, 'language', {
      configurable: true, enumerable: true,
      get: function () { return ''; },
    });
    Object.defineProperty(Navigator.prototype, 'platform', {
      configurable: true, enumerable: true,
      get: function () { return 'Linux x86_64'; },
    });
    window.Navigator = Navigator;
    window.navigator = new Navigator();

    function Notification() {}
    Notification.permission = 'default';
    window.Notification = Notification;

    function Permissions() {}
    Permissions.prototype.query = function (param) {
      // Headless Chromium ships this inconsistency: returns "denied"
      // for notifications regardless of Notification.permission.
      if (param && param.name === 'notifications') {
        return Promise.resolve({ state: 'denied', name: 'notifications' });
      }
      return Promise.resolve({ state: 'granted', name: param && param.name });
    };
    window.Permissions = Permissions;
    `,
    ctx,
  );
  return ctx;
}

describe("buildStealthScript", () => {
  it("emits a self-contained IIFE with stable hash for identical options", () => {
    const a = buildStealthScript();
    const b = buildStealthScript();
    expect(a.source.startsWith(";(")).toBe(true);
    expect(a.source.endsWith(");")).toBe(true);
    expect(a.sha256).toEqual(b.sha256);
  });

  it("changes hash when options change", () => {
    const a = buildStealthScript({ hideWebdriver: true });
    const b = buildStealthScript({ hideWebdriver: false });
    expect(a.sha256).not.toEqual(b.sha256);
  });

  it("hides navigator.webdriver", () => {
    const ctx = setUpNav();
    const { source } = buildStealthScript({ hideWebdriver: true });
    runInContext(source, ctx);
    const wd = runInContext("navigator.webdriver", ctx);
    expect(wd).toBe(false);
  });

  it("synthesizes a non-empty navigator.plugins when fakePlugins is on", () => {
    const ctx = setUpNav();
    const { source } = buildStealthScript({ fakePlugins: true });
    runInContext(source, ctx);
    const len = runInContext("navigator.plugins.length", ctx);
    expect(len).toBe(1);
    const name = runInContext("navigator.plugins[0].name", ctx);
    expect(typeof name).toBe("string");
    expect((name as string).length).toBeGreaterThan(0);
  });

  it("sets navigator.languages and navigator.language together", () => {
    const ctx = setUpNav();
    const { source } = buildStealthScript({ languages: ["en-US", "fr"] });
    runInContext(source, ctx);
    const langs = runInContext("Array.from(navigator.languages)", ctx);
    expect(langs).toEqual(["en-US", "fr"]);
    const lang = runInContext("navigator.language", ctx);
    expect(lang).toBe("en-US");
  });

  it("respects an explicit platform override", () => {
    const ctx = setUpNav();
    const { source } = buildStealthScript({ platform: "MacIntel" });
    runInContext(source, ctx);
    const p = runInContext("navigator.platform", ctx);
    expect(p).toBe("MacIntel");
  });

  it("normalizes Permissions.query for notifications to match Notification.permission", async () => {
    const ctx = setUpNav();
    const { source } = buildStealthScript({ normalizePermissions: true });
    runInContext(source, ctx);
    // Pass the Promise back as a JSON-able result.
    const stateP = runInContext(
      "new window.Permissions().query({ name: 'notifications' }).then(function (r) { return r.state; })",
      ctx,
    );
    const state = await stateP;
    // Notification.permission is 'default' → shim returns 'prompt'.
    expect(state).toBe("prompt");
  });

  it("non-notifications permissions queries still go through to the original", async () => {
    const ctx = setUpNav();
    const { source } = buildStealthScript({ normalizePermissions: true });
    runInContext(source, ctx);
    const stateP = runInContext(
      "new window.Permissions().query({ name: 'camera' }).then(function (r) { return r.state; })",
      ctx,
    );
    const state = await stateP;
    // The mock's default-branch returns "granted".
    expect(state).toBe("granted");
  });

  it("opt-outs leave the surface untouched", () => {
    const ctx = setUpNav();
    const { source } = buildStealthScript({
      hideWebdriver: false,
      fakePlugins: false,
      languages: null,
    });
    runInContext(source, ctx);
    expect(runInContext("navigator.webdriver", ctx)).toBe(true);
    expect(runInContext("navigator.plugins.length", ctx)).toBe(0);
    expect(runInContext("Array.from(navigator.languages)", ctx)).toEqual([]);
  });
});
