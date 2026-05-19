import type { ApiDefinition } from "./types.js";

/**
 * Browser-extension fingerprinting surface.
 *
 * Detectors probe for installed extensions by:
 *   1. Reading injected DOM/style artifacts (`document.styleSheets`,
 *      `document.adoptedStyleSheets`, `getComputedStyle` on hidden
 *      probe elements) — 2021 Fingerprinting in Style.
 *   2. Calling `chrome.runtime.sendMessage(extId, …)` against a
 *      known extension ID and observing whether the call returns or
 *      throws — 2020 Carnus.
 *   3. Watching for extension-injected `<link rel='stylesheet'>` /
 *      `<script src='chrome-extension://…'>` resources.
 *
 * The `chrome.*` namespace is already a watched root via the
 * `chrome.runtime` family of entries in `navigator.ts`; this file
 * adds the high-signal probe-side methods. The corresponding
 * style-probing patterns (e.g. `document.adoptedStyleSheets`,
 * `getComputedStyle` on display:none elements) are already covered
 * by `document.ts` and `css-style.ts`.
 */
export const extensionsApis: ApiDefinition[] = [
  // `chrome.runtime` itself lives in window-screen.ts (it's primarily
  // a headless tell). The extension-probe sub-properties — id,
  // sendMessage, connect, etc. — live here.
  {
    key: "chrome.runtime.id",
    category: "extensions",
    severity: "medium",
    description: "chrome.runtime.id. Undefined when read from a content-script context with no manifest match, populated when read from an extension page. Used to detect specific known extensions.",
    botDetectionTell: true,
  },
  {
    key: "chrome.runtime.sendMessage",
    category: "extensions",
    severity: "high",
    botDetectionTell: true,
    description: "chrome.runtime.sendMessage(extensionId, message). Sending to a known extension's ID either returns a response or sets `chrome.runtime.lastError`; the response/no-response distinction reveals whether the extension is installed. Canonical Carnus probe.",
    evasion: "Stub `chrome.runtime.sendMessage` to silently swallow and return undefined for all known anti-detect probe IDs; ensure `chrome.runtime.lastError` is set consistently.",
  },
  {
    key: "chrome.runtime.connect",
    category: "extensions",
    severity: "high",
    botDetectionTell: true,
    description: "chrome.runtime.connect(extensionId). Persistent-port variant of sendMessage; same installed-extension probe.",
  },
  {
    key: "chrome.runtime.lastError",
    category: "extensions",
    severity: "medium",
    description: "chrome.runtime.lastError. Set after a failing chrome.runtime.* call. Detectors read this after sendMessage to invert the probe (no error = extension exists).",
    botDetectionTell: true,
  },
  {
    key: "chrome.runtime.getManifest",
    category: "extensions",
    severity: "medium",
    description: "chrome.runtime.getManifest. Only defined in an extension context; presence pins the script as running from an extension.",
  },
  {
    key: "chrome.runtime.getURL",
    category: "extensions",
    severity: "low",
    description: "chrome.runtime.getURL. Resolves a chrome-extension:// URL — used by content scripts to load packaged resources.",
  },
  {
    key: "chrome.webstore",
    category: "extensions",
    severity: "medium",
    description: "chrome.webstore. Removed from Chrome in 2018; presence on a UA claiming a modern Chrome is a spoof tell.",
    botDetectionTell: true,
  },
  {
    key: "chrome.app",
    category: "extensions",
    severity: "low",
    description: "chrome.app (chrome.app.isInstalled / chrome.app.getDetails). Vestigial after Chrome App deprecation, but a few packers still probe for it.",
  },
  // The style-injection probe family. Detectors enumerate
  // document.styleSheets / document.adoptedStyleSheets and inspect
  // cssRules looking for extension-injected rules; we already catalog
  // those reads in css-style.ts and document.ts, so this entry mostly
  // serves to document the probe-pattern intent.
  {
    key: "*.cssRules",
    category: "extensions",
    severity: "medium",
    description: "StyleSheet.cssRules. Iterating these on every stylesheet pre/post a known extension's load detects rule injection. Pair with document.styleSheets enumeration for the full Fingerprinting-in-Style (2021) probe.",
    botDetectionTell: true,
  },
  {
    key: "*.ownerNode",
    category: "extensions",
    severity: "low",
    description: "CSSStyleSheet.ownerNode. Returns the <style>/<link> element backing the sheet — extension-injected sheets often have unusual owners (or none).",
  },
];
