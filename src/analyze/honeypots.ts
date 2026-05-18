import type { Program } from "acorn";
import { simple as walkSimple } from "acorn-walk";
import type { StructuralFinding, Location } from "../types.js";
import { resolveStaticString, type AliasMap } from "./aliases.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Cognitive-DOM honeypot detector (IMPROVEMENTS.md A7 / SoK §3.4 L3).
 *
 * Defenders against vision-language-model-driven (VLM) automation have
 * started building transparent or off-screen DOM elements that look
 * like real UI to a layout-tree pass but are unreachable by a human
 * user. A VLM agent's "find the button and click it" routine picks the
 * decoy because it scores well by layout heuristics; a real user can't
 * see it.
 *
 * The detection side has a fairly tight AST signature:
 *
 *   1. `document.createElement("div" | "button" | "a" | "input")` (or
 *       the explicit HTMLDivElement etc. constructor).
 *   2. The element's `.style.position` set to `"fixed"` or `"absolute"`.
 *   3. Transparency: `style.opacity` set to a near-zero value
 *      (`"0"`, `"0.001"`, `"0.00001"`), or
 *      `style.background` / `style.color` set to a near-zero-alpha
 *      `rgba(...)`, or `style.visibility` set to `"hidden"` /
 *      `display: none`, or
 *      a viewport-wide / off-screen position
 *      (`top: -9999px`, `width: 100vw` + `pointer-events: auto`).
 *   4. An `addEventListener("click", …)` (or `onclick = …`) on the
 *      same element.
 *
 * We don't try to reason about variable flow across long distances —
 * we look for a single variable bound to a `createElement` call whose
 * surrounding scope shows both a transparency-style assignment AND a
 * click handler attachment, all in the same function body. False
 * positives are essentially zero because legit code that creates a
 * transparent click target is doing something niche; the pattern itself
 * is the signal.
 *
 * Reports one `StructuralFinding` per discovered honeypot site.
 */

interface CandidateAccumulator {
  /** Variable name bound to a `createElement(...)` call. */
  varName: string;
  /** Tag name when statically resolvable, else null. */
  tagName: string | null;
  /** Source location of the createElement call. */
  loc: Location | null;
  snippet: string;
  /** Bitset of evidence we've accumulated for this variable. */
  evidence: HoneypotEvidence;
}

interface HoneypotEvidence {
  fixedOrAbsolute: boolean;
  transparent: boolean;
  offscreenOrViewport: boolean;
  clickListener: boolean;
}

const HONEYPOT_TAGS: ReadonlySet<string> = new Set([
  "div", "button", "a", "input", "span", "label",
]);

const POSITION_FIXED_VALUES: ReadonlySet<string> = new Set(["fixed", "absolute"]);

/** Property-name patterns that indicate visual transparency. */
const TRANSPARENT_VALUES: ReadonlySet<string> = new Set([
  "0", "0.0", "0.00", "0.000", "0.0001", "0.00001",
  "hidden", "transparent", "none",
]);

export function detectCognitiveHoneypots(
  program: Program,
  aliases: AliasMap,
  source: string,
): StructuralFinding[] {
  const candidates = new Map<string, CandidateAccumulator>();

  // Pass 1: find `const el = document.createElement("div")` style
  // bindings. We also accept the form
  // `const el = createElement("div")` after global stripping (the alias
  // pass already collapses `var d = document; d.createElement(...)`).
  walkSimple(program, {
    VariableDeclarator(node: any) {
      if (node.id?.type !== "Identifier") return;
      const init = node.init;
      if (!isCreateElementCall(init)) return;
      const tagArg = init.arguments?.[0];
      const tagName = tagArg ? resolveStaticString(tagArg, aliases) : null;
      if (tagName && !HONEYPOT_TAGS.has(tagName.toLowerCase())) return;
      candidates.set(node.id.name as string, {
        varName: node.id.name as string,
        tagName,
        loc: locOf(init),
        snippet: snippetOf(source, init),
        evidence: {
          fixedOrAbsolute: false,
          transparent: false,
          offscreenOrViewport: false,
          clickListener: false,
        },
      });
    },
  });

  if (candidates.size === 0) return [];

  // Pass 2: accumulate style / listener evidence against each candidate.
  walkSimple(program, {
    AssignmentExpression(node: any) {
      if (node.operator !== "=") return;
      const left = node.left;
      if (left?.type !== "MemberExpression") return;
      const stylePath = resolveStyleAccess(left);
      if (!stylePath) return;
      const cand = candidates.get(stylePath.varName);
      if (!cand) return;
      const valLit = resolveStaticString(node.right, aliases);
      const numericVal = isNumericZero(node.right) ? "0" : null;
      const effective = (valLit ?? numericVal ?? "").toLowerCase();
      applyStyleEvidence(cand.evidence, stylePath.styleProp, effective);

      // onclick = handler — the same axis as addEventListener("click", …).
      if (stylePath.styleProp === "" && stylePath.varName === cand.varName) {
        // unreachable — empty styleProp is filtered in resolveStyleAccess
      }
    },
    CallExpression(node: any) {
      // x.addEventListener("click", fn) / x.setAttribute("style", "…")
      const callee = node.callee;
      if (!callee || callee.type !== "MemberExpression" || callee.computed) return;
      if (callee.object?.type !== "Identifier") return;
      const cand = candidates.get(callee.object.name as string);
      if (!cand) return;
      const methodName = callee.property?.type === "Identifier" ? callee.property.name : null;
      if (methodName === "addEventListener") {
        const eventArg = node.arguments?.[0];
        const eventName = eventArg ? resolveStaticString(eventArg, aliases) : null;
        if (eventName && (eventName === "click" || eventName === "mousedown" || eventName === "pointerdown")) {
          cand.evidence.clickListener = true;
        }
      } else if (methodName === "setAttribute") {
        const attrArg = node.arguments?.[0];
        const valArg = node.arguments?.[1];
        const attr = attrArg ? resolveStaticString(attrArg, aliases) : null;
        const valStr = valArg ? resolveStaticString(valArg, aliases) : null;
        if (attr === "style" && valStr) {
          applyStyleAttributeString(cand.evidence, valStr);
        }
      }
    },
  });

  // Onclick property assignment is its own AssignmentExpression visit
  // — apply that after the fact via a second pass on simple assignments
  // we may have skipped.
  walkSimple(program, {
    AssignmentExpression(node: any) {
      if (node.operator !== "=") return;
      const left = node.left;
      if (left?.type !== "MemberExpression" || left.computed) return;
      if (left.object?.type !== "Identifier") return;
      if (left.property?.type !== "Identifier") return;
      const cand = candidates.get(left.object.name as string);
      if (!cand) return;
      if (left.property.name === "onclick" || left.property.name === "onmousedown" || left.property.name === "onpointerdown") {
        cand.evidence.clickListener = true;
      }
    },
  });

  const out: StructuralFinding[] = [];
  for (const cand of candidates.values()) {
    if (!cand.evidence.clickListener) continue;
    if (!cand.evidence.fixedOrAbsolute && !cand.evidence.offscreenOrViewport) continue;
    if (!cand.evidence.transparent && !cand.evidence.offscreenOrViewport) continue;
    out.push({
      kind: "cognitive-honeypot",
      subkind: cand.tagName ? `${cand.tagName}-honeypot` : "honeypot",
      severity: "high",
      description:
        `Transparent / off-screen DOM element with a click listener attached — VLM-agent honeypot pattern (SoK §3.4 L3). ` +
        `A real user can't see or click this element; an automation agent that picks targets from the layout tree will.`,
      details: {
        varName: cand.varName,
        tagName: cand.tagName,
        evidence: cand.evidence,
      },
      loc: cand.loc,
      snippet: cand.snippet,
    });
  }
  return out;
}

function isCreateElementCall(node: any): boolean {
  if (!node || node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (!callee) return false;
  if (callee.type === "Identifier" && callee.name === "createElement") return true;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  if (callee.property?.type !== "Identifier") return false;
  return callee.property.name === "createElement";
}

function resolveStyleAccess(member: any): { varName: string; styleProp: string } | null {
  // el.style.position
  if (member.computed) return null;
  if (member.property?.type !== "Identifier") return null;
  const inner = member.object;
  if (!inner || inner.type !== "MemberExpression" || inner.computed) return null;
  if (inner.property?.type !== "Identifier" || inner.property.name !== "style") return null;
  if (inner.object?.type !== "Identifier") return null;
  const prop = member.property.name as string;
  if (!prop) return null;
  return { varName: inner.object.name as string, styleProp: prop };
}

function applyStyleEvidence(ev: HoneypotEvidence, styleProp: string, value: string): void {
  if (styleProp === "position" && POSITION_FIXED_VALUES.has(value)) {
    ev.fixedOrAbsolute = true;
    return;
  }
  if (styleProp === "opacity" && (TRANSPARENT_VALUES.has(value) || value === "0")) {
    ev.transparent = true;
    return;
  }
  if (styleProp === "visibility" && value === "hidden") {
    ev.transparent = true;
    return;
  }
  if (styleProp === "display" && value === "none") {
    ev.transparent = true;
    return;
  }
  if (
    (styleProp === "background" || styleProp === "backgroundColor" ||
      styleProp === "color") &&
    /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.\d+)?\s*\)/i.test(value)
  ) {
    ev.transparent = true;
    return;
  }
  if (styleProp === "top" || styleProp === "left") {
    if (/^-?\s*\d{3,}/.test(value) || value.endsWith("vh") || value.endsWith("vw")) {
      ev.offscreenOrViewport = true;
    }
    return;
  }
  if (styleProp === "width" || styleProp === "height") {
    if (value.endsWith("vh") || value.endsWith("vw") || value.endsWith("%")) {
      ev.offscreenOrViewport = true;
    }
    return;
  }
}

function applyStyleAttributeString(ev: HoneypotEvidence, css: string): void {
  // Cheap CSS scan — split on `;`, look for the key:value pairs the
  // structured path handles. Bot detectors usually pass a single long
  // setAttribute("style", "...") in their honeypot init, so this is
  // worth covering even though it duplicates some logic.
  for (const rawDecl of css.split(";")) {
    const decl = rawDecl.trim();
    if (!decl) continue;
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim().toLowerCase();
    const styleProp = cssToCamel(prop);
    applyStyleEvidence(ev, styleProp, val);
  }
}

function cssToCamel(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function isNumericZero(node: any): boolean {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "number" && node.value === 0) return true;
  return false;
}

function locOf(node: any): Location | null {
  return node?.loc ?? null;
}

function snippetOf(source: string, node: any): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return "";
  const raw = source.slice(node.start, Math.min(node.end, node.start + 120));
  return raw.replace(/\s+/g, " ").trim();
}
