import type { Program } from "acorn";
import { simple as walkSimple } from "acorn-walk";
import { resolveChain, resolveStaticString, type AliasMap } from "./aliases.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What we know about the value bound to a local variable. The tracer
 * uses these to reason about payload shapes — when a script does
 * `var data = { ua: navigator.userAgent }; fetch(url, { body: JSON.stringify(data) })`,
 * the value record for `data` lets us still report ua leaking out.
 *
 * This is a conservative single-assignment model. Reassignments shadow
 * (we only track first-write-wins) and methods that mutate (FormData
 * .append/.set, .push on arrays, etc.) accumulate via a side-table.
 */
export type ValueOrigin =
  | { kind: "object-literal"; entries: ValueEntry[]; rawSnippet: string }
  | { kind: "chain"; chain: string[]; rawSnippet: string }
  | { kind: "literal"; value: string | number | boolean | null; rawSnippet: string }
  | { kind: "formdata"; appends: ValueEntry[] }
  | { kind: "urlsearchparams"; appends: ValueEntry[] }
  | { kind: "json-stringify"; argName?: string; argOrigin?: ValueOrigin; rawSnippet: string }
  | { kind: "unknown"; rawSnippet: string };

export interface ValueEntry {
  key: string;
  /** When the value is a known property chain. */
  chain?: string[];
  /** When the value is a literal. */
  literalValue?: string | number | boolean | null;
  /** When the value points to another tracked variable. */
  refName?: string;
  /** Source snippet of the value expression for display. */
  snippet: string;
}

export interface ValueMap {
  /** First-binding value origin per local variable name. */
  origins: Map<string, ValueOrigin>;
}

export function buildValues(program: Program, aliases: AliasMap, source: string): ValueMap {
  const origins = new Map<string, ValueOrigin>();

  // Pass 1: collect initial bindings from VariableDeclarators.
  walkSimple(program, {
    VariableDeclarator(node) {
      const decl = node as any;
      if (decl.id?.type !== "Identifier" || !decl.init) return;
      const name = decl.id.name as string;
      if (origins.has(name)) return;
      const origin = classifyValue(decl.init, aliases, source);
      if (origin) origins.set(name, origin);
    },
    AssignmentExpression(node) {
      const a = node as any;
      if (a.operator !== "=" || a.left?.type !== "Identifier") return;
      const name = a.left.name as string;
      if (origins.has(name)) return;
      const origin = classifyValue(a.right, aliases, source);
      if (origin) origins.set(name, origin);
    },
  });

  // Pass 2: accumulate FormData/URLSearchParams .append / .set / .delete calls
  // and object-property assignments back into the origin records.
  walkSimple(program, {
    CallExpression(node) {
      const c = node as any;
      const callee = c.callee;
      if (!callee || callee.type !== "MemberExpression" || callee.computed) return;
      if (callee.object?.type !== "Identifier") return;
      const targetName = callee.object.name as string;
      const origin = origins.get(targetName);
      if (!origin) return;
      const methodName = callee.property?.name;
      if (origin.kind !== "formdata" && origin.kind !== "urlsearchparams") return;
      if (methodName !== "append" && methodName !== "set") return;
      const keyArg = c.arguments?.[0];
      const valArg = c.arguments?.[1];
      const keyStr = resolveStaticString(keyArg, aliases);
      if (keyStr === null) return;
      const entry = entryFromValueExpr(keyStr, valArg, aliases, source);
      origin.appends.push(entry);
    },
    AssignmentExpression(node) {
      const a = node as any;
      if (a.operator !== "=") return;
      // obj.key = value  → augment object-literal origin
      if (a.left?.type !== "MemberExpression") return;
      if (a.left.computed) {
        // obj["key"] = value
        const keyStr = resolveStaticString(a.left.property, aliases);
        if (keyStr === null) return;
        if (a.left.object?.type !== "Identifier") return;
        const origin = origins.get(a.left.object.name as string);
        if (!origin || origin.kind !== "object-literal") return;
        origin.entries.push(entryFromValueExpr(keyStr, a.right, aliases, source));
      } else {
        if (a.left.property?.type !== "Identifier") return;
        if (a.left.object?.type !== "Identifier") return;
        const origin = origins.get(a.left.object.name as string);
        if (!origin || origin.kind !== "object-literal") return;
        origin.entries.push(entryFromValueExpr(a.left.property.name as string, a.right, aliases, source));
      }
    },
  });

  return { origins };
}

/** Reduce an expression to a ValueOrigin when it's something we can track. */
export function classifyValue(node: any, aliases: AliasMap, source: string): ValueOrigin | null {
  if (!node) return null;

  // Literals.
  const lit = resolveStaticString(node, aliases);
  if (lit !== null) {
    return { kind: "literal", value: lit, rawSnippet: snippet(node, source) };
  }
  if (node.type === "Literal" && (typeof node.value === "number" || typeof node.value === "boolean" || node.value === null)) {
    return { kind: "literal", value: node.value, rawSnippet: snippet(node, source) };
  }

  // Object literal.
  if (node.type === "ObjectExpression") {
    const entries: ValueEntry[] = [];
    for (const p of node.properties ?? []) {
      // SpreadElement of an inline ObjectExpression: splice its entries in
      // so `{ ...{ a: x.y }, b }` doesn't silently lose `a`.
      if (p.type === "SpreadElement" && p.argument?.type === "ObjectExpression") {
        const inner = classifyValue(p.argument, aliases, source);
        if (inner?.kind === "object-literal") {
          for (const e of inner.entries) entries.push(e);
        }
        continue;
      }
      // SpreadElement of an identifier (`{...x}`): leave for tracePayload
      // to resolve via the value map — record an opaque marker so the
      // downstream resolver knows to look it up. acorn produces `Property`
      // (not Babel's `ObjectProperty`) so the latter is unreachable.
      if (p.type === "SpreadElement") {
        if (p.argument?.type === "Identifier") {
          entries.push({ key: `...${p.argument.name}`, refName: p.argument.name, snippet: snippet(p, source) });
        }
        continue;
      }
      if (p.type !== "Property") continue;
      const k = p.computed ? resolveStaticString(p.key, aliases) : p.key?.name ?? (typeof p.key?.value === "string" ? p.key.value : null);
      if (k === null || k === undefined) continue;
      entries.push(entryFromValueExpr(String(k), p.value, aliases, source));
    }
    return { kind: "object-literal", entries, rawSnippet: snippet(node, source) };
  }

  // Property chain reference.
  const chain = resolveChain(node, aliases);
  if (chain) {
    return { kind: "chain", chain: chain.filter((s): s is string => typeof s === "string"), rawSnippet: snippet(node, source) };
  }

  // new FormData() / new URLSearchParams()
  if (node.type === "NewExpression" && node.callee?.type === "Identifier") {
    const ctorName = node.callee.name;
    if (ctorName === "FormData") return { kind: "formdata", appends: [] };
    if (ctorName === "URLSearchParams") {
      // URLSearchParams accepts three init shapes: object, query string,
      // or array of `[k, v]` pairs. The original implementation only
      // handled the object form; the other two are common in real
      // beacons (`new URLSearchParams("k=v&...")` especially) so we
      // resolve them here for static leak detection to work.
      const init = node.arguments?.[0];
      const appends: ValueEntry[] = [];
      if (init?.type === "ObjectExpression") {
        for (const p of init.properties ?? []) {
          if (p.type !== "Property") continue;
          const k = p.computed ? resolveStaticString(p.key, aliases) : p.key?.name ?? null;
          if (k === null || k === undefined) continue;
          appends.push(entryFromValueExpr(String(k), p.value, aliases, source));
        }
      } else if (init?.type === "ArrayExpression") {
        // [["k", "v"], ["k2", value]] — first elt is the key, second is the value.
        for (const elt of init.elements ?? []) {
          if (!elt || elt.type !== "ArrayExpression") continue;
          const kNode = elt.elements?.[0];
          const vNode = elt.elements?.[1];
          if (!kNode) continue;
          const k = resolveStaticString(kNode, aliases);
          if (k === null) continue;
          if (!vNode) {
            appends.push({ key: k, snippet: snippet(elt, source) });
            continue;
          }
          appends.push(entryFromValueExpr(k, vNode, aliases, source));
        }
      } else if (init) {
        const lit = resolveStaticString(init, aliases);
        if (lit !== null && lit.length > 0) {
          for (const part of lit.split("&")) {
            if (!part) continue;
            const eq = part.indexOf("=");
            const rawK = eq >= 0 ? part.slice(0, eq) : part;
            const rawV = eq >= 0 ? part.slice(eq + 1) : "";
            let k: string;
            let v: string;
            try {
              k = decodeURIComponent(rawK);
              v = decodeURIComponent(rawV);
            } catch {
              k = rawK;
              v = rawV;
            }
            appends.push({ key: k, literalValue: v, snippet: `${k}=${v}` });
          }
        }
      }
      return { kind: "urlsearchparams", appends };
    }
  }

  // JSON.stringify(arg)
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "JSON" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "stringify"
  ) {
    const arg = node.arguments?.[0];
    if (arg) {
      const argName = arg.type === "Identifier" ? (arg.name as string) : undefined;
      const argOrigin = classifyValue(arg, aliases, source) ?? undefined;
      return { kind: "json-stringify", argName, argOrigin, rawSnippet: snippet(node, source) };
    }
  }

  return null;
}

/** Build a ValueEntry for a key/value pair where value is an arbitrary expression. */
function entryFromValueExpr(key: string, valNode: any, aliases: AliasMap, source: string): ValueEntry {
  if (!valNode) return { key, snippet: "" };
  const lit = resolveStaticString(valNode, aliases);
  if (lit !== null) return { key, literalValue: lit, snippet: snippet(valNode, source) };
  if (valNode.type === "Literal" && (typeof valNode.value === "number" || typeof valNode.value === "boolean" || valNode.value === null)) {
    return { key, literalValue: valNode.value, snippet: snippet(valNode, source) };
  }
  const chain = resolveChain(valNode, aliases);
  if (chain) {
    const cleaned = chain.filter((s): s is string => typeof s === "string");
    if (cleaned.length > 0) {
      const refName = valNode.type === "Identifier" ? (valNode.name as string) : undefined;
      return { key, chain: cleaned, refName, snippet: snippet(valNode, source) };
    }
  }
  if (valNode.type === "Identifier") {
    return { key, refName: valNode.name as string, snippet: snippet(valNode, source) };
  }
  return { key, snippet: snippet(valNode, source) };
}

function snippet(node: any, source: string): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return "";
  const raw = source.slice(node.start, node.end);
  return raw.replace(/\s+/g, " ").trim();
}
