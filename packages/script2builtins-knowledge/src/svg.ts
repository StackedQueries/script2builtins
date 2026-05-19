import type { ApiDefinition } from "./types.js";

/**
 * SVG geometry probes. SVGGraphicsElement.getBBox and the SVGTextContentElement
 * length methods rasterize text against the system font stack and return
 * sub-pixel measurements — alternative path to fillText/measureText that
 * stealth shims often forget to patch. CreepJS extracts a separate
 * "SVGRect" hash from these calls.
 */
export const svgApis: ApiDefinition[] = [
  {
    key: "*.getBBox",
    category: "svg",
    severity: "high",
    botDetectionTell: true,
    description: "SVGGraphicsElement.getBBox(). Returns SVGRect with sub-pixel x/y/width/height — strong font-metrics fingerprint that bypasses canvas hooks.",
    evasion: "Patch SVGGraphicsElement.prototype.getBBox; verify the returned object's prototype matches DOMRect/SVGRect spec to avoid lie-detection.",
  },
  {
    key: "*.getComputedTextLength",
    category: "svg",
    severity: "high",
    botDetectionTell: true,
    description: "SVGTextContentElement.getComputedTextLength(). Floating-point pixel length of rendered text — per-system, per-font-stack.",
  },
  {
    key: "*.getSubStringLength",
    category: "svg",
    severity: "medium",
    description: "SVGTextContentElement.getSubStringLength(). Length of an arbitrary substring; adds entropy beyond getComputedTextLength.",
  },
  {
    key: "*.getExtentOfChar",
    category: "svg",
    severity: "medium",
    description: "SVGTextContentElement.getExtentOfChar(). Per-glyph bbox; used in glyph-grid font probes.",
  },
  {
    key: "*.getNumberOfChars",
    category: "svg",
    severity: "info",
    description: "Char count; usually trivial.",
  },
  {
    key: "*.getStartPositionOfChar",
    category: "svg",
    severity: "medium",
    description: "Per-glyph x/y; another font-metric leak.",
  },
  {
    key: "SVGRect",
    category: "svg",
    severity: "low",
    description: "SVGRect constructor — sometimes referenced via prototype chains in cross-realm probes.",
  },
];
