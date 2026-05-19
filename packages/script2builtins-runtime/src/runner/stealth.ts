/**
 * Stealth-mode init script.
 *
 * Runs **before** the trap as a separate `addInitScript` so it can
 * patch a small set of `navigator` / `Notification` surfaces whose
 * defaults give away a Playwright-driven Chromium. The matrix of what
 * this covers (and what it deliberately does not) lives in
 * `docs/stealth-mode.md`.
 *
 * Design rules:
 *
 *   - This is a **defensive shim**, not a fingerprint spoofer. It
 *     normalizes a handful of values that are reliably wrong under
 *     headless automation; it does not attempt to forge a coherent
 *     fingerprint vector. See `docs/limits.md` §7 — the runtime is
 *     research-grade, not a scraping toolkit.
 *
 *   - The shim's source is hashed and surfaced on the {@link Session}
 *     as `stealthScriptSha256`. Reports include the hash so a reader
 *     can tell which session was instrumented with which shim.
 *
 *   - The shim never references the trap's identifiers (channel name,
 *     worker-trap global). Both names are randomized per attach, so a
 *     user-supplied stealth script can call
 *     `Session.channelName` / `Session.workerTrapGlobalName` to avoid
 *     them.
 */
import { createHash } from "node:crypto";

export interface StealthOptions {
  /**
   * Override `navigator.languages`. Default `["en-US", "en"]`. Set to
   * `null` to leave the platform default in place.
   */
  languages?: string[] | null;
  /**
   * Override `navigator.platform`. Default leaves the platform default
   * in place. Set to e.g. `"MacIntel"` to normalize across runners.
   */
  platform?: string | null;
  /**
   * Patch `navigator.webdriver` to return `false`. Default `true`. The
   * "webdriver-active" signal is the single most reliable headless
   * tell, so this is the one shim worth defaulting on.
   */
  hideWebdriver?: boolean;
  /**
   * Synthesize a non-empty `navigator.plugins` collection. Default
   * `true`. Headless Chromium reports zero plugins — a single-bit
   * signal that the FingerprintJS-class probes check for.
   */
  fakePlugins?: boolean;
  /**
   * Make `Permissions.query({name:"notifications"})` consistent with
   * `Notification.permission`. Default `true`. Headless Chromium ships
   * a known inconsistency (`Permissions` returns "denied" while
   * `Notification` returns "default") that detectors compare against.
   */
  normalizePermissions?: boolean;
}

export interface BuiltStealthScript {
  source: string;
  sha256: string;
  options: Required<StealthOptions>;
}

const DEFAULTS: Required<StealthOptions> = {
  languages: ["en-US", "en"],
  platform: null,
  hideWebdriver: true,
  fakePlugins: true,
  normalizePermissions: true,
};

/**
 * Build a stealth init script. The source is a self-contained IIFE
 * with no external references — same constraint as the trap script,
 * since it ships through `addInitScript` and runs in the page world.
 */
export function buildStealthScript(opts: StealthOptions = {}): BuiltStealthScript {
  const resolved: Required<StealthOptions> = {
    languages: opts.languages === undefined ? DEFAULTS.languages : opts.languages,
    platform: opts.platform === undefined ? DEFAULTS.platform : opts.platform,
    hideWebdriver: opts.hideWebdriver ?? DEFAULTS.hideWebdriver,
    fakePlugins: opts.fakePlugins ?? DEFAULTS.fakePlugins,
    normalizePermissions: opts.normalizePermissions ?? DEFAULTS.normalizePermissions,
  };
  const config = JSON.stringify(resolved);
  const fn = stealthMain.toString();
  const source = `;(${fn})(${config});`;
  const sha256 = createHash("sha256").update(source).digest("hex");
  return { source, sha256, options: resolved };
}

/**
 * In-page stealth shim. Stringified by {@link buildStealthScript}.
 *
 * Same stringification rules as `trapMain`: no imports, no TS-only
 * syntax, every helper defined inside the function body.
 */
function stealthMain(config: Required<StealthOptions>): void {
  // Bail silently if we're not in a window context (workers, etc.).
  const w: any = typeof window !== "undefined" ? window : null;
  if (!w) return;
  const nav: any = w.navigator;
  if (!nav) return;
  const NavProto: any = w.Navigator ? w.Navigator.prototype : null;
  const defineOnProto = function (key: string, value: any): boolean {
    // Patch the prototype getter so the historical `navigator.<key>`
    // descriptor still resolves through Navigator.prototype — that's
    // what detectors that walk `Object.getOwnPropertyDescriptor(
    // Navigator.prototype, key)` actually read.
    if (!NavProto) return false;
    try {
      Object.defineProperty(NavProto, key, {
        get: function () { return value; },
        configurable: true,
        enumerable: true,
      });
      return true;
    } catch (_e) {
      return false;
    }
  };

  // ─── 1. navigator.webdriver ──────────────────────────────────────
  if (config.hideWebdriver) {
    try { delete (nav as any).webdriver; } catch (_e) {}
    defineOnProto("webdriver", false);
  }

  // ─── 2. navigator.languages / language ───────────────────────────
  if (config.languages && config.languages.length > 0) {
    const langs = config.languages.slice();
    defineOnProto("languages", Object.freeze(langs));
    defineOnProto("language", langs[0]);
  }

  // ─── 3. navigator.platform ───────────────────────────────────────
  if (config.platform) {
    defineOnProto("platform", config.platform);
  }

  // ─── 4. navigator.plugins / mimeTypes ────────────────────────────
  // Headless Chromium reports zero plugins. We synthesize a
  // PluginArray-shaped object with one entry so the
  // `navigator.plugins.length === 0` probe stops firing. We don't
  // attempt to forge a coherent fingerprint vector — see
  // docs/stealth-mode.md.
  if (config.fakePlugins) {
    try {
      const fakePlugin: any = {
        name: "Chrome PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "Portable Document Format",
        length: 1,
      };
      fakePlugin[0] = { type: "application/pdf", suffixes: "pdf", description: "" };
      const pluginArray: any = [fakePlugin];
      (pluginArray as any).item = function (i: number) { return pluginArray[i] || null; };
      (pluginArray as any).namedItem = function (n: string) {
        for (let i = 0; i < pluginArray.length; i++) {
          if (pluginArray[i].name === n) return pluginArray[i];
        }
        return null;
      };
      (pluginArray as any).refresh = function () {};
      defineOnProto("plugins", pluginArray);
    } catch (_e) {}
  }

  // ─── 5. Permissions / Notification consistency ───────────────────
  if (config.normalizePermissions && w.Permissions && w.Permissions.prototype) {
    try {
      const origQuery = w.Permissions.prototype.query;
      if (typeof origQuery === "function") {
        w.Permissions.prototype.query = function (param: any) {
          if (param && param.name === "notifications") {
            // Mirror what `Notification.permission` claims, instead of
            // headless Chromium's hardcoded "denied".
            const state = w.Notification && w.Notification.permission === "default"
              ? "prompt"
              : (w.Notification ? w.Notification.permission : "prompt");
            return Promise.resolve({
              state: state,
              name: "notifications",
              onchange: null,
              addEventListener: function () {},
              removeEventListener: function () {},
              dispatchEvent: function () { return false; },
            } as any);
          }
          return origQuery.apply(this, arguments as any);
        };
      }
    } catch (_e) {}
  }
}
