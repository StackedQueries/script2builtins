import type { Program } from "acorn";
import { simple as walkSimple } from "acorn-walk";
import type { StructuralFinding, Location } from "../types.js";
import { resolveStaticString, type AliasMap } from "./aliases.js";
import { locOf, snippetOf } from "./util.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Favicon-cache persistent-tracking probe detector
 * ("Tales of FAVICONS and Caches", 2021).
 *
 * The trick: a `<link rel="icon">` href is assigned to a per-visitor
 * unique URL, the browser fetches and caches it, and a later `new
 * Image()` with the same URL fingerprints whether the cache hit (the
 * load is instant) or missed (the round-trip is visible). The cache
 * persists across most clear-site-data flows, so it functions as an
 * evercookie-class identifier.
 *
 * Static signature:
 *   1. A `document.createElement("link")` call (or a `querySelector`
 *      that matches `link[rel=icon]`-ish).
 *   2. A `.rel` assignment with one of the icon rel values
 *      ("icon", "shortcut icon", "apple-touch-icon", "mask-icon", …),
 *      or a `setAttribute("rel", ...)` with the same value.
 *   3. An `Image` constructor / `new Image()` somewhere in the program.
 *   4. At least one timer read (`performance.now` / `Date.now`).
 *
 * The pattern is niche enough that even (1) + (3) co-occurring is
 * suspicious; we require (2) AND (4) to keep false positives at zero
 * outside detector code.
 */

const ICON_REL_VALUES: ReadonlySet<string> = new Set([
  "icon",
  "shortcut icon",
  "apple-touch-icon",
  "apple-touch-icon-precomposed",
  "mask-icon",
  "fluid-icon",
]);

interface FaviconAccumulator {
  /** Loc of the createElement("link") call. */
  linkLoc: Location | null;
  linkSnippet: string;
  /** Loc of the rel = "icon" assignment (or setAttribute call). */
  relLoc: Location | null;
  relSnippet: string;
  /** Variable name bound to createElement("link"), when statically resolvable. */
  varName: string | null;
}

interface FaviconState {
  /** Per-variable accumulator for the `var l = document.createElement("link")` form. */
  candidates: Map<string, FaviconAccumulator>;
  /** Set when the program calls `new Image()` (or `new Image(url)`). */
  hasImageCtor: boolean;
  imageCtorLoc: Location | null;
  imageCtorSnippet: string;
  /** Set when the program reads performance.now or Date.now. */
  hasTimerRead: boolean;
  timerLoc: Location | null;
  timerSnippet: string;
}

export function detectFaviconCacheProbes(
  program: Program,
  aliases: AliasMap,
  source: string,
): StructuralFinding[] {
  const state: FaviconState = {
    candidates: new Map(),
    hasImageCtor: false,
    imageCtorLoc: null,
    imageCtorSnippet: "",
    hasTimerRead: false,
    timerLoc: null,
    timerSnippet: "",
  };

  // Pass 1: find `var l = document.createElement("link")` bindings,
  // remember the `new Image()` and timer-read presence.
  walkSimple(program, {
    VariableDeclarator(node: any) {
      if (node.id?.type !== "Identifier") return;
      const init = node.init;
      if (!isCreateElementLinkCall(init, aliases)) return;
      state.candidates.set(node.id.name as string, {
        linkLoc: locOf(init),
        linkSnippet: snippetOf(source, init),
        relLoc: null,
        relSnippet: "",
        varName: node.id.name as string,
      });
    },
    NewExpression(node: any) {
      if (node.callee?.type === "Identifier" && node.callee.name === "Image") {
        state.hasImageCtor = true;
        state.imageCtorLoc ??= locOf(node);
        state.imageCtorSnippet ||= snippetOf(source, node);
      }
    },
    MemberExpression(node: any) {
      if (node.computed) return;
      const propName = node.property?.type === "Identifier" ? node.property.name : null;
      if (propName !== "now") return;
      const obj = node.object;
      if (obj?.type !== "Identifier") return;
      if (obj.name === "performance" || obj.name === "Date") {
        state.hasTimerRead = true;
        state.timerLoc ??= locOf(node);
        state.timerSnippet ||= snippetOf(source, node);
      }
    },
  });

  if (state.candidates.size === 0) return [];

  // Pass 2: catch `l.rel = "icon"` and `l.setAttribute("rel", "icon")`
  // against each candidate.
  walkSimple(program, {
    AssignmentExpression(node: any) {
      if (node.operator !== "=") return;
      const left = node.left;
      if (left?.type !== "MemberExpression" || left.computed) return;
      if (left.object?.type !== "Identifier") return;
      if (left.property?.type !== "Identifier") return;
      const cand = state.candidates.get(left.object.name as string);
      if (!cand) return;
      if (left.property.name !== "rel") return;
      const valStr = resolveStaticString(node.right, aliases);
      if (!valStr) return;
      if (!ICON_REL_VALUES.has(valStr.toLowerCase().trim())) return;
      cand.relLoc = locOf(node);
      cand.relSnippet = snippetOf(source, node);
    },
    CallExpression(node: any) {
      const callee = node.callee;
      if (!callee || callee.type !== "MemberExpression" || callee.computed) return;
      if (callee.object?.type !== "Identifier") return;
      const cand = state.candidates.get(callee.object.name as string);
      if (!cand) return;
      const methodName = callee.property?.type === "Identifier" ? callee.property.name : null;
      if (methodName !== "setAttribute") return;
      const attr = resolveStaticString(node.arguments?.[0], aliases);
      const val = resolveStaticString(node.arguments?.[1], aliases);
      if (attr?.toLowerCase() !== "rel" || !val) return;
      if (!ICON_REL_VALUES.has(val.toLowerCase().trim())) return;
      cand.relLoc = locOf(node);
      cand.relSnippet = snippetOf(source, node);
    },
  });

  const out: StructuralFinding[] = [];
  for (const cand of state.candidates.values()) {
    if (!cand.relLoc) continue;
    if (!state.hasImageCtor) continue;
    if (!state.hasTimerRead) continue;
    out.push({
      kind: "favicon-cache-probe",
      subkind: "link-icon-plus-image-timing",
      severity: "high",
      description:
        "`<link rel=\"icon\">` href assignment co-occurs with `new Image()` and a high-resolution timer read — favicon-cache persistent-tracking probe (Tales of FAVICONS and Caches, 2021). The browser favicon cache survives most clear-site-data flows; load-time delta identifies returning visitors.",
      details: {
        varName: cand.varName,
        linkLoc: cand.linkLoc,
        relLoc: cand.relLoc,
        imageCtorLoc: state.imageCtorLoc,
        timerLoc: state.timerLoc,
      },
      loc: cand.relLoc ?? cand.linkLoc,
      snippet: cand.relSnippet || cand.linkSnippet,
    });
  }
  return out;
}

function isCreateElementLinkCall(node: any, aliases: AliasMap): boolean {
  if (!node || node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (!callee) return false;
  if (callee.type === "Identifier" && callee.name === "createElement") {
    return argMatches(node.arguments?.[0], "link", aliases);
  }
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  if (callee.property?.type !== "Identifier" || callee.property.name !== "createElement") return false;
  return argMatches(node.arguments?.[0], "link", aliases);
}

function argMatches(arg: any, expected: string, aliases: AliasMap): boolean {
  if (!arg) return false;
  const s = resolveStaticString(arg, aliases);
  return s !== null && s.toLowerCase() === expected;
}

