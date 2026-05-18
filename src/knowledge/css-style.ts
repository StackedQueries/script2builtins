import type { ApiDefinition } from "../types.js";

/**
 * CSS / computed-style fingerprinting. Two related techniques:
 *
 * 1. Enumerate getComputedStyle(element) keys/values for browser- and
 *    OS-specific CSS properties — total key count differs by engine version
 *    (Chrome 113 has 1317 keys, FF differs). Used by CreepJS's
 *    "Computed Style" probe.
 *
 * 2. Element-geometry / font-rendering inference via getComputedStyle.
 *    Reading `inlineSize`/`blockSize` of an absolutely-positioned text node
 *    avoids fillText hooks but still leaks font metrics.
 *
 * 3. CSS.supports("...") for feature flags (`color-scheme`, `accent-color`,
 *    `appearance: button`, etc.) — a fast, JS-only browser-version probe.
 */
export const cssStyleApis: ApiDefinition[] = [
  {
    key: "getComputedStyle",
    category: "css",
    severity: "high",
    botDetectionTell: true,
    description: "window.getComputedStyle(element). Iterating the returned CSSStyleDeclaration enumerates every supported CSS property — strong browser-version fingerprint. Also used for font-presence inference without canvas.",
    evasion: "Hard to intercept without breaking layout. Stealth tooling usually doesn't patch this surface; defending requires CSS-property-list spoofing at the engine.",
  },
  {
    key: "*.getComputedStyle",
    category: "css",
    severity: "high",
    botDetectionTell: true,
    description: "Same surface, accessed via aliased receiver (var gcs = getComputedStyle).",
  },
  {
    key: "CSS.supports",
    category: "css",
    severity: "medium",
    botDetectionTell: true,
    description: "Feature-detection sieve. A bulk CSS.supports() probe over ~50 properties pins the browser engine and version.",
  },
  {
    key: "CSS.escape",
    category: "css",
    severity: "info",
    description: "CSS selector escaping; rarely fingerprinted.",
  },
  // `*.cssRules` and `document.styleSheets` live in extensions.ts and
  // document.ts respectively — the entries there cover both the
  // CSS-introspection axis (this category) and the extension-detection
  // axis (Fingerprinting in Style, 2021).
  {
    key: "CSSStyleSheet",
    category: "css",
    severity: "info",
    description: "Constructor feature probe (constructable stylesheets — Chrome 73+).",
  },
  {
    key: "*.matches",
    category: "css",
    severity: "info",
    description: "Element.matches(selector). Used in selector-fingerprint probes (CSS extension detection via :has() + custom selectors).",
  },
  {
    key: "*.getPropertyValue",
    category: "css",
    severity: "low",
    description: "CSSStyleDeclaration.getPropertyValue. Used by extension-fingerprinting probes to read CSS custom-property values that an extension's content script might inject.",
  },
  {
    key: "*.inlineSize",
    category: "css",
    severity: "medium",
    description: "CSSStyleDeclaration.inlineSize. Sub-pixel logical-axis width of a rendered text node — alternative font-metric path that doesn't touch canvas. Used by CreepJS for emoji width fingerprints.",
    botDetectionTell: true,
  },
  {
    key: "*.blockSize",
    category: "css",
    severity: "medium",
    description: "CSSStyleDeclaration.blockSize. Companion to inlineSize.",
  },
];
