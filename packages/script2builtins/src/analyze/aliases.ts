import type { Program } from "acorn";
import { simple as walkSimple } from "acorn-walk";

/**
 * Aliases collected from a program. Bot-detection scripts routinely
 * stash globals and frequently-used strings in locals to make pattern
 * matching harder; tracking both is the difference between detecting
 * `navigator.userAgent` and missing it entirely.
 *
 * Resolution is deliberately conservative — we only record assignments
 * we can statically reduce. Reassignment is ignored. This is a forensic
 * heuristic, not a sound data-flow analysis.
 */
export interface AliasMap {
  /** Local name → resolved global property chain. */
  chains: Map<string, string[]>;
  /** Local name → resolved string value. */
  strings: Map<string, string>;
  /**
   * Local name → constant string-table array. These are the `_0x1234`
   * arrays commercial obfuscators (javascript-obfuscator and the AWS WAF /
   * Cloudflare / Akamai challenge scripts the StableBrowse "reading
   * challenge scripts" post dissects) index into — `obj[_0x1234[0x3]]`.
   * Only tables we can prove are NOT rotated at runtime are kept; a
   * rotated table indexed statically would yield the wrong string and
   * produce a false match, so {@link rotatedTables} members are excluded.
   */
  arrays: Map<string, Array<string | number | boolean | null>>;
  /**
   * Simple decoder functions `function d(i){ return _0xtable[i - 0x10]; }`
   * mapped to their table + offset, so `obj[d(0x13)]` folds. Only emitted
   * for non-rotated tables.
   */
  decoders: Map<string, { table: string; offset: number }>;
}

export function buildAliases(program: Program): AliasMap {
  const aliases: AliasMap = {
    chains: new Map(),
    strings: new Map(),
    arrays: new Map(),
    decoders: new Map(),
  };

  // Pass 0a: collect candidate constant string-table arrays.
  const candidateArrays = new Map<string, Array<string | number | boolean | null>>();
  walkSimple(program, {
    VariableDeclarator(node) {
      const decl = node as any;
      if (decl.id?.type !== "Identifier" || decl.init?.type !== "ArrayExpression") return;
      const name = decl.id.name as string;
      if (candidateArrays.has(name)) return;
      const arr = foldArrayLiteral(decl.init);
      if (arr) candidateArrays.set(name, arr);
    },
  });

  // Pass 0b: find tables mutated by a rotate/shuffle decoder IIFE
  // (`(function(arr,n){ ... arr.push(arr.shift()) ... })(_0x, 0x1f3)` or a
  // top-level `while`/`try` reshuffle). Indexing those statically is unsafe.
  const rotated = findRotatedTables(program, candidateArrays);
  for (const [name, arr] of candidateArrays) {
    if (!rotated.has(name)) aliases.arrays.set(name, arr);
  }

  // Pass 0c: simple decoder functions over non-rotated tables.
  collectDecoders(program, aliases);

  // Two passes so aliases can chain: `var n = navigator; var p = n.plugins;`
  // resolves on the second pass once `n` is known.
  for (let pass = 0; pass < 2; pass++) {
    walkSimple(program, {
      VariableDeclarator(node) {
        const decl = node as { id: { type: string; name?: string }; init: unknown };
        if (decl.id.type !== "Identifier" || !decl.init) return;
        const name = decl.id.name as string;
        if (aliases.chains.has(name) || aliases.strings.has(name)) return;
        const str = resolveStaticString(decl.init, aliases);
        if (str !== null) {
          aliases.strings.set(name, str);
          return;
        }
        const chain = resolveChain(decl.init, aliases);
        if (chain) aliases.chains.set(name, chain);
      },
    });
  }

  return aliases;
}

/**
 * Reduce an expression to a static dot-chain when possible. Returns
 * `null` if any segment can't be resolved.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveChain(node: any, aliases: AliasMap): string[] | null {
  if (!node || typeof node !== "object") return null;
  switch (node.type) {
    case "Identifier": {
      const aliased = aliases.chains.get(node.name);
      return aliased ? [...aliased] : [node.name];
    }
    case "ThisExpression":
      return ["this"];
    case "MemberExpression": {
      const head = resolveChain(node.object, aliases);
      if (!head) return null;
      const tail = resolveProperty(node, aliases);
      if (tail === null) return null;
      return [...head, tail];
    }
    default:
      return null;
  }
}

/** Resolve the property segment of a MemberExpression to a string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveProperty(member: any, aliases: AliasMap): string | null {
  if (!member.computed) {
    return member.property?.type === "Identifier" ? (member.property.name as string) : null;
  }
  return resolveStaticString(member.property, aliases);
}

/**
 * Reduce an expression to a string literal when possible.
 *
 * Delegates numeric/JSFuck/string-table folding to {@link evalConst} and
 * returns the result only when it reduces to a *string* — numeric and
 * boolean results stay `null` (a bare number is not a catalog-relevant
 * property key, and emitting one would create spurious chain segments).
 * This keeps existing behavior while letting obfuscated keys such as
 * `navigator[_0x[+!+[]]]` and `obj[String.fromCharCode(119,…)]` resolve.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveStaticString(node: any, aliases: AliasMap): string | null {
  if (!node || typeof node !== "object") return null;
  // TaggedTemplateExpression (`String.raw\`webdriver\``) is niche enough to
  // keep as an explicit special case rather than route through the evaluator.
  if (node.type === "TaggedTemplateExpression") return resolveTaggedTemplate(node);
  const cv = evalConst(node, aliases, 0);
  if (cv && cv.k === "str") return cv.v;
  return null;
}

/* --------------------------------------------------------------------- *
 * Constant evaluator
 *
 * A bounded mini-evaluator for the *constant* subset of JS that obfuscators
 * lean on: arithmetic/bitwise chains, JSFuck primitives (`+[]`, `!+[]`,
 * `+!+[]`), string concatenation, `String.fromCharCode`, and indexing into
 * known-constant string tables. It never executes calls beyond a small
 * allow-list and never touches I/O — it only folds literals.
 * --------------------------------------------------------------------- */

type CV =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "undef" }
  | { k: "arr"; v: CV[] };

const MAX_DEPTH = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function evalConst(node: any, aliases: AliasMap, depth: number): CV | null {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return null;
  switch (node.type) {
    case "Literal": {
      const v = node.value;
      if (typeof v === "string") return { k: "str", v };
      if (typeof v === "number") return { k: "num", v };
      if (typeof v === "boolean") return { k: "bool", v };
      if (v === null) return { k: "null" };
      return null; // regex, bigint
    }
    case "Identifier": {
      if (node.name === "undefined") return { k: "undef" };
      if (node.name === "NaN") return { k: "num", v: NaN };
      const s = aliases.strings.get(node.name);
      if (s !== undefined) return { k: "str", v: s };
      const arr = aliases.arrays.get(node.name);
      if (arr) return { k: "arr", v: arr.map(primToCV) };
      return null;
    }
    case "TemplateLiteral": {
      const quasis = node.quasis as Array<{ value: { cooked?: string } }>;
      const exprs = node.expressions as any[];
      let out = "";
      for (let i = 0; i < quasis.length; i++) {
        out += quasis[i]!.value.cooked ?? "";
        if (i < exprs.length) {
          const e = evalConst(exprs[i], aliases, depth + 1);
          if (!e) return null;
          out += toStr(e);
        }
      }
      return { k: "str", v: out };
    }
    case "ArrayExpression": {
      const out: CV[] = [];
      for (const el of node.elements ?? []) {
        if (el === null) {
          out.push({ k: "undef" });
          continue;
        }
        if (el.type === "SpreadElement") return null;
        const ev = evalConst(el, aliases, depth + 1);
        if (!ev) return null;
        out.push(ev);
      }
      return { k: "arr", v: out };
    }
    case "UnaryExpression": {
      if (node.operator === "void") return { k: "undef" };
      const a = evalConst(node.argument, aliases, depth + 1);
      if (!a) return null;
      switch (node.operator) {
        case "+": return { k: "num", v: toNum(a) };
        case "-": return { k: "num", v: -toNum(a) };
        case "~": return { k: "num", v: ~toNum(a) };
        case "!": return { k: "bool", v: !toBool(a) };
        default: return null;
      }
    }
    case "BinaryExpression": {
      const l = evalConst(node.left, aliases, depth + 1);
      const r = evalConst(node.right, aliases, depth + 1);
      if (!l || !r) return null;
      const op = node.operator as string;
      if (op === "+") {
        const lp = toPrimitive(l);
        const rp = toPrimitive(r);
        if (lp.k === "str" || rp.k === "str") return { k: "str", v: toStr(lp) + toStr(rp) };
        return { k: "num", v: toNum(lp) + toNum(rp) };
      }
      const ln = toNum(l);
      const rn = toNum(r);
      switch (op) {
        case "-": return { k: "num", v: ln - rn };
        case "*": return { k: "num", v: ln * rn };
        case "/": return { k: "num", v: ln / rn };
        case "%": return { k: "num", v: ln % rn };
        case "**": return { k: "num", v: ln ** rn };
        case "<<": return { k: "num", v: ln << rn };
        case ">>": return { k: "num", v: ln >> rn };
        case ">>>": return { k: "num", v: ln >>> rn };
        case "&": return { k: "num", v: ln & rn };
        case "|": return { k: "num", v: ln | rn };
        case "^": return { k: "num", v: ln ^ rn };
        default: return null;
      }
    }
    case "MemberExpression": {
      // Constant string-table index: TABLE[intExpr].
      if (!node.computed) return null;
      const obj = evalConst(node.object, aliases, depth + 1);
      if (!obj || obj.k !== "arr") return null;
      const idx = evalConst(node.property, aliases, depth + 1);
      if (!idx) return null;
      const i = toNum(idx);
      if (!Number.isInteger(i) || i < 0 || i >= obj.v.length) return null;
      return obj.v[i] ?? { k: "undef" };
    }
    case "CallExpression": {
      const fc = resolveFromCharCode(node);
      if (fc !== null) return { k: "str", v: fc };
      // Decoder-function fold: d(index) → table[index - offset].
      if (node.callee?.type === "Identifier") {
        const dec = aliases.decoders.get(node.callee.name);
        const arg = node.arguments?.[0];
        if (dec && arg) {
          const idxCV = evalConst(arg, aliases, depth + 1);
          const table = aliases.arrays.get(dec.table);
          if (idxCV && table) {
            const i = toNum(idxCV) - dec.offset;
            if (Number.isInteger(i) && i >= 0 && i < table.length) {
              return primToCV(table[i] ?? null);
            }
          }
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function primToCV(v: string | number | boolean | null): CV {
  if (typeof v === "string") return { k: "str", v };
  if (typeof v === "number") return { k: "num", v };
  if (typeof v === "boolean") return { k: "bool", v };
  return { k: "null" };
}

/** ECMAScript ToPrimitive (string/number hints irrelevant for our subset). */
function toPrimitive(cv: CV): CV {
  if (cv.k === "arr") return { k: "str", v: toStr(cv) };
  return cv;
}

function toStr(cv: CV): string {
  switch (cv.k) {
    case "str": return cv.v;
    case "num": return String(cv.v);
    case "bool": return String(cv.v);
    case "null": return "null";
    case "undef": return "undefined";
    case "arr": return cv.v.map((e) => (e.k === "null" || e.k === "undef" ? "" : toStr(e))).join(",");
  }
}

function toNum(cv: CV): number {
  switch (cv.k) {
    case "num": return cv.v;
    case "str": return cv.v.trim() === "" ? 0 : Number(cv.v);
    case "bool": return cv.v ? 1 : 0;
    case "null": return 0;
    case "undef": return NaN;
    case "arr": {
      if (cv.v.length === 0) return 0;
      if (cv.v.length === 1) return toNum(cv.v[0]!);
      return NaN;
    }
  }
}

function toBool(cv: CV): boolean {
  switch (cv.k) {
    case "bool": return cv.v;
    case "num": return cv.v !== 0 && !Number.isNaN(cv.v);
    case "str": return cv.v.length > 0;
    case "null":
    case "undef": return false;
    case "arr": return true; // any object is truthy
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function foldArrayLiteral(arrNode: any): Array<string | number | boolean | null> | null {
  const out: Array<string | number | boolean | null> = [];
  for (const el of arrNode.elements ?? []) {
    if (!el) return null;
    if (el.type === "Literal") {
      const v = el.value;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) {
        out.push(v);
        continue;
      }
      return null;
    }
    // `-1` style negative numeric literals.
    if (el.type === "UnaryExpression" && el.operator === "-" && el.argument?.type === "Literal" && typeof el.argument.value === "number") {
      out.push(-el.argument.value);
      continue;
    }
    return null;
  }
  return out.length ? out : null;
}

/**
 * Detect string tables that are (or may be) reordered at runtime — the
 * rotate/shuffle IIFE every javascript-obfuscator build emits, e.g.
 * `(function(arr, n){ … arr.push(arr.shift()) … })(_0x, 0x1f3)`. Indexing a
 * rotated table statically gives the wrong element and a false catalog
 * match, so we exclude such tables entirely (preferring a miss + reported
 * hazard over a wrong positive).
 *
 * Two conservative signals mark a table unsafe:
 *  1. It is passed as an argument to ANY call/new — the rotation IIFE always
 *     hands the table in (and mutates it through the parameter alias, which a
 *     name-only scan at the push/shift site would miss). Safe static indexing
 *     never needs to pass the table to a function.
 *  2. It is the direct receiver of a mutating array method
 *     (push/shift/unshift/reverse/sort/splice/copyWithin).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRotatedTables(program: any, candidates: Map<string, unknown>): Set<string> {
  const rotated = new Set<string>();
  const MUTATORS = new Set(["push", "shift", "unshift", "reverse", "sort", "splice", "copyWithin"]);
  const markIfTable = (node: any) => {
    if (node?.type === "Identifier" && candidates.has(node.name)) rotated.add(node.name);
  };
  walkSimple(program, {
    CallExpression(node: any) {
      // Signal 1: table passed as a call argument.
      for (const a of node.arguments ?? []) markIfTable(a);
      // Signal 2: direct mutation `_0x.push(...)`.
      const callee = node.callee;
      if (callee?.type === "MemberExpression" && !callee.computed && MUTATORS.has(callee.property?.name)) {
        markIfTable(callee.object);
      }
    },
    NewExpression(node: any) {
      for (const a of node.arguments ?? []) markIfTable(a);
    },
  });
  return rotated;
}

/**
 * Collect simple decoder functions of the shape
 * `function d(i){ return _0xTable[i - 0x10]; }` (or `+`), where the table
 * is a known non-rotated table. Both function declarations and
 * `var d = function(i){…}` are handled.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectDecoders(program: any, aliases: AliasMap): void {
  const consider = (name: string | undefined, fn: any) => {
    if (!name || !fn || (fn.type !== "FunctionDeclaration" && fn.type !== "FunctionExpression" && fn.type !== "ArrowFunctionExpression")) return;
    const param = fn.params?.[0];
    if (param?.type !== "Identifier") return;
    const body = fn.body;
    let ret: any = null;
    if (body?.type === "BlockStatement") {
      const stmts = body.body ?? [];
      if (stmts.length !== 1 || stmts[0].type !== "ReturnStatement") return;
      ret = stmts[0].argument;
    } else {
      ret = body; // arrow with expression body
    }
    // ret must be TABLE[ param (± offset) ]
    if (!ret || ret.type !== "MemberExpression" || !ret.computed) return;
    if (ret.object?.type !== "Identifier") return;
    const table = ret.object.name as string;
    if (!aliases.arrays.has(table)) return;
    const idx = ret.property;
    let offset = 0;
    if (idx?.type === "Identifier" && idx.name === param.name) {
      offset = 0;
    } else if (
      idx?.type === "BinaryExpression" &&
      (idx.operator === "-" || idx.operator === "+") &&
      idx.left?.type === "Identifier" &&
      idx.left.name === param.name &&
      idx.right?.type === "Literal" &&
      typeof idx.right.value === "number"
    ) {
      offset = idx.operator === "-" ? idx.right.value : -idx.right.value;
    } else {
      return;
    }
    aliases.decoders.set(name, { table, offset });
  };
  walkSimple(program, {
    FunctionDeclaration(node: any) {
      consider(node.id?.name, node);
    },
    VariableDeclarator(node: any) {
      if (node.id?.type === "Identifier") consider(node.id.name, node.init);
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveTaggedTemplate(node: any): string | null {
  // `String.raw\`webdriver\`` and identity-tagged template literals
  // (`id\`webdriver\``) reduce to their underlying string in commercial
  // detectors that want to dodge naive substring scans.
  const quasi = node.quasi;
  if (!quasi || quasi.type !== "TemplateLiteral") return null;
  if (quasi.expressions?.length !== 0) return null;
  const tag = node.tag;
  const isStringRaw =
    tag?.type === "MemberExpression" &&
    !tag.computed &&
    tag.object?.type === "Identifier" &&
    tag.object.name === "String" &&
    tag.property?.type === "Identifier" &&
    tag.property.name === "raw";
  const isPlainIdentTag = tag?.type === "Identifier";
  if (!isStringRaw && !isPlainIdentTag) return null;
  const useRaw = isStringRaw;
  return (quasi.quasis as Array<{ value: { cooked?: string; raw?: string } }>)
    .map((q) => (useRaw ? q.value.raw ?? "" : q.value.cooked ?? ""))
    .join("");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveFromCharCode(call: any): string | null {
  const callee = call.callee;
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;
  // Bare String.fromCharCode(...)
  if (
    callee.object?.type === "Identifier" &&
    callee.object.name === "String" &&
    callee.property?.type === "Identifier" &&
    callee.property.name === "fromCharCode"
  ) {
    return charCodesToString(call.arguments);
  }
  // String.fromCharCode.apply(null, [...])
  if (
    callee.property?.type === "Identifier" &&
    callee.property.name === "apply" &&
    callee.object?.type === "MemberExpression" &&
    !callee.object.computed &&
    callee.object.object?.type === "Identifier" &&
    callee.object.object.name === "String" &&
    callee.object.property?.type === "Identifier" &&
    callee.object.property.name === "fromCharCode"
  ) {
    const arr = call.arguments?.[1];
    if (!arr || arr.type !== "ArrayExpression") return null;
    return charCodesToString(arr.elements);
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function charCodesToString(args: any[] | undefined): string | null {
  if (!args || args.length === 0) return null;
  const codes: number[] = [];
  for (const a of args) {
    if (!a) return null;
    if (a.type === "Literal" && typeof a.value === "number" && Number.isInteger(a.value) && a.value >= 0 && a.value <= 0x10ffff) {
      codes.push(a.value);
      continue;
    }
    if (
      a.type === "UnaryExpression" &&
      a.operator === "-" &&
      a.argument?.type === "Literal" &&
      typeof a.argument.value === "number"
    ) {
      return null;
    }
    return null;
  }
  try {
    return String.fromCodePoint(...codes);
  } catch {
    return null;
  }
}
