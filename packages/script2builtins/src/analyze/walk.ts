import type { Program } from "acorn";
import { ancestor as walkAncestor, simple as walkSimple } from "acorn-walk";
import type { RawAccess, DynamicHazard } from "../types.js";
import {
  buildAliases,
  resolveProperty,
  resolveStaticString,
  type AliasMap,
} from "./aliases.js";
import { locOf } from "./util.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WalkResult {
  accesses: RawAccess[];
  hazards: DynamicHazard[];
  aliases: AliasMap;
}

interface WalkOptions {
  source: string;
  watchedRoots: Set<string>;
  snippetLength: number;
}

/** Globals stripped from chain heads so `window.navigator.x` and `navigator.x` collapse. */
const GLOBAL_ROOTS = new Set([
  "window",
  "self",
  "globalThis",
  "top",
  "parent",
  "frames",
]);

export function walkProgram(program: Program, opts: WalkOptions): WalkResult {
  const aliases = buildAliases(program);
  const accesses: RawAccess[] = [];
  const hazards: DynamicHazard[] = [];

  walkAncestor(program, {
    MemberExpression(node, _state, ancestors) {
      const member = node as any;
      const ancs = ancestors as any[];
      const parent = parentOf(ancs);
      // Skip inner members of a longer chain — the outer one will emit the full chain.
      if (parent && parent.type === "MemberExpression" && parent.object === member) {
        return;
      }
      const called = isCalled(member, parent);
      const access = extractMemberChain(member, aliases);
      if (!access) return;
      accesses.push({
        ...access,
        called,
        loc: locOf(member),
        snippet: sliceSnippet(opts.source, member, opts.snippetLength),
        firstStringArg: called && parent ? firstStringArgOf(parent, aliases) : undefined,
      });
    },

    Identifier(node, _state, ancestors) {
      const ident = node as any;
      const ancs = ancestors as any[];
      if (!isReferenceIdentifier(ident, ancs)) return;
      if (!opts.watchedRoots.has(ident.name)) return;
      const parent = parentOf(ancs);
      const called = isCalled(ident, parent);
      const resolved = aliases.chains.get(ident.name) ?? [ident.name];
      const stripped = stripGlobalHead(resolved);
      accesses.push({
        chain: stripped.length ? stripped : [ident.name],
        called,
        loc: locOf(ident),
        snippet: sliceSnippet(opts.source, ident, opts.snippetLength),
        resolvedThroughObfuscation: aliases.chains.has(ident.name),
        hasDynamicSegment: false,
        firstStringArg: called && parent ? firstStringArgOf(parent, aliases) : undefined,
      });
    },

    CallExpression(call) {
      collectCallHazards(call as any, aliases, hazards, opts.source, opts.snippetLength);
    },

    NewExpression(call) {
      collectCallHazards(call as any, aliases, hazards, opts.source, opts.snippetLength);
    },

    WithStatement(node) {
      hazards.push({
        kind: "with-statement",
        loc: locOf(node as any),
        snippet: sliceSnippet(opts.source, node as any, opts.snippetLength),
        detail: "`with` blocks dynamically scope identifier resolution; static analysis cannot follow accesses inside.",
      });
    },

    ImportExpression(node) {
      hazards.push({
        kind: "import-call",
        loc: locOf(node as any),
        snippet: sliceSnippet(opts.source, node as any, opts.snippetLength),
        detail: "Dynamic `import()` may pull in additional fingerprinting code at runtime.",
      });
    },

    DebuggerStatement(node) {
      // Canonical anti-debug trap from Botguard-class VMs: a stray
      // `debugger;` will pause execution when DevTools is attached and
      // pass through silently otherwise. Detectors then compare the
      // pre/post timestamps; a long gap means an analyst is watching.
      // Pair the count of these with the timing-delta hazards (B2) to
      // gauge whether the script is performing chronometric integrity
      // checks (SoK §3.4 L4).
      hazards.push({
        kind: "debugger-statement",
        loc: locOf(node as any),
        snippet: sliceSnippet(opts.source, node as any, opts.snippetLength),
        detail: "`debugger` statement — pauses execution under DevTools, no-op otherwise. Anti-debug trap when followed by a `performance.now()` delta measurement.",
      });
    },

    BinaryExpression(node) {
      collectChronometricHazards(node as any, aliases, hazards, opts.source, opts.snippetLength);
    },

    ForStatement(node) {
      collectCpuPauseHazard(node as any, hazards, opts.source, opts.snippetLength);
    },
  });

  // Post-pass: resolve clock-read variable bindings for the timing-delta
  // detector. We need this because the canonical pattern is two-step:
  //   `var a = performance.now(); ...; var b = performance.now(); b - a > 5`.
  resolveTimingDeltaProbes(program, aliases, hazards, opts.source, opts.snippetLength);

  // Post-pass: synthesize accesses for `Reflect.get(ROOT, "prop")` and
  // `Object.getOwnPropertyDescriptor(ROOT, "prop").get.call(receiver)`
  // when ROOT and prop are both statically resolvable. These are the
  // stealth-bypass trampolines detectors use to dodge naive substring
  // scans; resolving them puts the access back on the catalog's radar.
  resolveTrampolines(program, aliases, accesses, opts.source, opts.snippetLength);

  return { accesses, hazards, aliases };
}

function parentOf(ancestors: any[]): any | null {
  // ancestors includes the visited node at the end; the parent is the one before.
  return ancestors.length >= 2 ? (ancestors[ancestors.length - 2] ?? null) : null;
}

function isCalled(node: any, parent: any | null): boolean {
  if (!parent) return false;
  if (parent.type === "CallExpression" && parent.callee === node) return true;
  if (parent.type === "NewExpression" && parent.callee === node) return true;
  return false;
}

/**
 * Identifiers appear in many non-reference roles: bindings, labels,
 * non-computed property names, etc. This filters to true reference uses.
 */
function isReferenceIdentifier(ident: any, ancestors: any[]): boolean {
  const parent = parentOf(ancestors);
  if (!parent) return true;

  switch (parent.type) {
    case "MemberExpression":
      // `.identifier` (property) is not a reference unless computed.
      if (parent.property === ident && !parent.computed) return false;
      return true;
    case "Property":
      // Object-literal key: `{ foo: 1 }` — `foo` is not a reference.
      if (parent.key === ident && !parent.computed) {
        // Shorthand `{ navigator }` IS a reference (key === value === ident).
        return parent.shorthand === true;
      }
      return true;
    case "PropertyDefinition":
      if (parent.key === ident && !parent.computed) return false;
      return true;
    case "VariableDeclarator":
      return parent.id !== ident;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      if (parent.id === ident) return false;
      if (Array.isArray(parent.params) && parent.params.includes(ident)) return false;
      return true;
    case "ClassDeclaration":
    case "ClassExpression":
      return parent.id !== ident;
    case "MethodDefinition":
      return parent.computed ? true : parent.key !== ident;
    case "CatchClause":
      return parent.param !== ident;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return parent.label !== ident;
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
      return false;
    case "AssignmentPattern":
      return parent.left !== ident;
    case "RestElement":
      return parent.argument !== ident;
    default:
      return true;
  }
}

type MemberExtractionFields = Pick<
  RawAccess,
  "chain" | "resolvedThroughObfuscation" | "hasDynamicSegment"
>;

function extractMemberChain(member: any, aliases: AliasMap): MemberExtractionFields | null {
  const parts: (string | null)[] = [];
  let resolvedThroughObfuscation = false;
  let hasDynamicSegment = false;
  let cursor: any = member;

  while (cursor && cursor.type === "MemberExpression") {
    const seg = resolveProperty(cursor, aliases);
    if (seg === null) {
      hasDynamicSegment = true;
      const fallback = cursor.computed ? resolveStaticString(cursor.property, aliases) : null;
      if (fallback !== null) {
        parts.push(fallback);
        resolvedThroughObfuscation = true;
      } else {
        parts.push(null);
      }
    } else {
      if (cursor.computed) resolvedThroughObfuscation = true;
      parts.push(seg);
    }
    cursor = cursor.object;
  }

  const root = resolveRoot(cursor, aliases);
  if (root.aliased) resolvedThroughObfuscation = true;
  if (root.dynamic) hasDynamicSegment = true;

  parts.reverse();
  const fullChain = [...root.chain, ...parts];
  const stripped = stripGlobalHead(fullChain);
  return {
    chain: stripped.length ? stripped : fullChain,
    resolvedThroughObfuscation,
    hasDynamicSegment,
  };
}

function resolveRoot(
  node: any,
  aliases: AliasMap,
): { chain: (string | null)[]; aliased: boolean; dynamic: boolean } {
  if (node && node.type === "Identifier") {
    const aliased = aliases.chains.get(node.name);
    if (aliased) return { chain: [...aliased], aliased: true, dynamic: false };
    return { chain: [node.name], aliased: false, dynamic: false };
  }
  if (node && node.type === "ThisExpression") {
    return { chain: ["this"], aliased: false, dynamic: false };
  }
  return { chain: [null], aliased: false, dynamic: true };
}

function stripGlobalHead(chain: (string | null)[]): (string | null)[] {
  let i = 0;
  while (i < chain.length - 1) {
    const seg = chain[i];
    if (typeof seg === "string" && GLOBAL_ROOTS.has(seg)) {
      i++;
      continue;
    }
    break;
  }
  return chain.slice(i);
}

function collectCallHazards(
  call: any,
  aliases: AliasMap,
  hazards: DynamicHazard[],
  source: string,
  snippetLength: number,
): void {
  if (call.type === "NewExpression") {
    const calleeName = identifierName(call.callee, aliases);
    if (calleeName === "Function") {
      const firstArg = call.arguments?.[0];
      if (firstArg && isObfuscatedEvalArg(firstArg, aliases)) {
        hazards.push({
          kind: "obfuscated-eval",
          loc: locOf(call),
          snippet: sliceSnippet(source, call, snippetLength),
          detail: "`new Function` constructed from a runtime-decoded payload (charCode / atob / decode chain) — opcode-array-to-code synthesis pattern.",
        });
        return;
      }
      hazards.push({
        kind: "Function",
        loc: locOf(call),
        snippet: sliceSnippet(source, call, snippetLength),
        detail: "`new Function` constructor compiles a string into a function — common eval-equivalent in fingerprinting blobs.",
      });
    }
    return;
  }

  const callee = call.callee;
  const calleeName = identifierName(callee, aliases);
  const firstArg = call.arguments[0];

  if (calleeName === "eval") {
    if (firstArg && isObfuscatedEvalArg(firstArg, aliases)) {
      hazards.push({
        kind: "obfuscated-eval",
        loc: locOf(call),
        snippet: sliceSnippet(source, call, snippetLength),
        detail: "`eval` fed a runtime-decoded payload (atob / decodeURIComponent / charCode chain). Code is doubly hidden — both eval'd and obfuscated.",
      });
      return;
    }
    hazards.push({
      kind: "eval",
      loc: locOf(call),
      snippet: sliceSnippet(source, call, snippetLength),
      detail: "`eval` runs arbitrary source at runtime — content is invisible to static analysis.",
    });
    return;
  }
  if (calleeName === "Function") {
    if (firstArg && isObfuscatedEvalArg(firstArg, aliases)) {
      hazards.push({
        kind: "obfuscated-eval",
        loc: locOf(call),
        snippet: sliceSnippet(source, call, snippetLength),
        detail: "`Function` constructor fed a runtime-decoded payload (atob / decodeURIComponent / charCode chain).",
      });
      return;
    }
    hazards.push({
      kind: "Function",
      loc: locOf(call),
      snippet: sliceSnippet(source, call, snippetLength),
      detail: "`Function` constructor compiles a string into a function — common eval-equivalent in fingerprinting blobs.",
    });
    return;
  }
  if (calleeName === "setTimeout" || calleeName === "setInterval") {
    if (firstArg && resolveStaticString(firstArg, aliases) !== null) {
      hazards.push({
        kind: calleeName === "setTimeout" ? "setTimeout-string" : "setInterval-string",
        loc: locOf(call),
        snippet: sliceSnippet(source, call, snippetLength),
        detail: `\`${calleeName}\` called with a string argument is an eval-equivalent.`,
      });
    }
    return;
  }
  if (callee && callee.type === "MemberExpression") {
    const propName = !callee.computed && callee.property?.type === "Identifier" ? callee.property.name : null;
    if (propName === "write" || propName === "writeln") {
      const objChain = chainOfRoot(callee.object, aliases);
      if (objChain && objChain[objChain.length - 1] === "document") {
        hazards.push({
          kind: "document-write",
          loc: locOf(call),
          snippet: sliceSnippet(source, call, snippetLength),
          detail: "`document.write` can inject script tags that load further fingerprinting code.",
        });
      }
    }
    // Function.prototype.constructor("...") — explicit constructor-as-eval
    // trampoline used to bypass simple `Function`/`eval` lookups.
    const calleeChain = chainOfRoot(callee, aliases);
    if (calleeChain && calleeChain.length >= 3) {
      const tail3 = calleeChain.slice(-3).join(".");
      if (tail3 === "Function.prototype.constructor") {
        hazards.push({
          kind: "obfuscated-eval",
          loc: locOf(call),
          snippet: sliceSnippet(source, call, snippetLength),
          detail: "`Function.prototype.constructor` invoked as a code-compilation trampoline — equivalent to `new Function(...)` but avoids the `Function` identifier.",
        });
      }
    }
  }
}

/**
 * Recognize an argument to eval/Function that's been wrapped in a
 * runtime-decode chain. Variants covered:
 *
 * - `atob(...)`
 * - `decodeURIComponent(...)` (often `decodeURIComponent(escape(...))`)
 * - `String.fromCharCode(...)` / `String.fromCharCode.apply(null, [...])`
 * - any nested combination
 *
 * The caller has already established that this expression is being
 * passed to eval, Function, or new Function.
 */
function isObfuscatedEvalArg(node: any, aliases: AliasMap): boolean {
  if (!node || typeof node !== "object") return false;
  if (node.type === "CallExpression") {
    const calleeName = identifierName(node.callee, aliases);
    if (calleeName === "atob") return true;
    if (calleeName === "decodeURIComponent") return true;
    if (calleeName === "unescape") return true;
    // String.fromCharCode(...) and String.fromCharCode.apply(...)
    const calleeChain = chainOfRoot(node.callee, aliases);
    if (calleeChain) {
      const dotted = calleeChain.join(".");
      if (dotted === "String.fromCharCode") return true;
      if (dotted === "String.fromCharCode.apply") return true;
      if (dotted === "String.fromCharCode.call") return true;
    }
    // Recurse one level into the first argument so e.g.
    // `eval(decodeURIComponent(escape(payload)))` matches at the outer
    // decodeURIComponent call.
    return false;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return isObfuscatedEvalArg(node.left, aliases) || isObfuscatedEvalArg(node.right, aliases);
  }
  return false;
}

/**
 * Pattern detector for the chronometric integrity probes from SoK §3.4
 * (L4) and the Botguard chronometric defense.
 *
 * Recognizes:
 *   - **clock-skew-probe**: `Date.now() - performance.now()` (or vice
 *     versa). Real-clock drift vs monotonic — near-zero false positive
 *     because legit code rarely diffs the two clocks in one expression.
 *
 * The inline form of the timing-delta probe — `performance.now() -
 * performance.now() > N` — also matches here, though it's vanishingly
 * rare in real code (the two reads are almost always bound to
 * variables; see {@link resolveTimingDeltaProbes}).
 */
function collectChronometricHazards(
  expr: any,
  aliases: AliasMap,
  hazards: DynamicHazard[],
  source: string,
  snippetLength: number,
): void {
  if (expr.operator !== "-") return;
  const leftSrc = clockSourceOfExpression(expr.left, aliases);
  const rightSrc = clockSourceOfExpression(expr.right, aliases);
  if (!leftSrc || !rightSrc) return;
  if (leftSrc !== rightSrc) {
    hazards.push({
      kind: "clock-skew-probe",
      loc: locOf(expr),
      snippet: sliceSnippet(source, expr, snippetLength),
      detail: "Subtraction across `Date.now()` and `performance.now()` — real-clock vs monotonic-clock drift probe. Detects time manipulation or sandbox-clock skew.",
    });
  }
}

/** What clock a syntactic expression reads from, or null. */
function clockSourceOfExpression(node: any, aliases: AliasMap): "performance" | "date" | null {
  if (!node) return null;
  if (node.type !== "CallExpression") return null;
  const chain = chainOfRoot(node.callee, aliases);
  if (!chain) return null;
  const dotted = chain.join(".");
  if (dotted === "performance.now" || dotted.endsWith(".performance.now")) return "performance";
  if (dotted === "Date.now") return "date";
  return null;
}

/**
 * The canonical Botguard signature isn't inline — it's bound to
 * variables:
 *
 *   const a = performance.now();
 *   ...  // possibly a `debugger;` or large no-op loop
 *   const b = performance.now();
 *   if (b - a > 5) { corruptSeed(); }
 *
 * We need a small post-pass to spot it.
 *
 * Step 1: Find all `VariableDeclarator` / `AssignmentExpression` whose
 *         RHS is `performance.now()` or `Date.now()`. Record the name
 *         → clock source.
 *
 * Step 2: Find all `BinaryExpression(op '>', '>=', '<', '<=')` where
 *         one side is a `BinaryExpression(op '-')` between two such
 *         clock-bound identifiers (same source — different sources fall
 *         into clock-skew above) and the other side is a numeric Literal.
 */
function resolveTimingDeltaProbes(
  program: any,
  aliases: AliasMap,
  hazards: DynamicHazard[],
  source: string,
  snippetLength: number,
): void {
  const clockBindings = new Map<string, "performance" | "date">();

  walkSimple(program, {
    VariableDeclarator(node: any) {
      if (node.id?.type !== "Identifier" || !node.init) return;
      const src = clockSourceOfExpression(node.init, aliases);
      if (src) clockBindings.set(node.id.name, src);
    },
    AssignmentExpression(node: any) {
      if (node.operator !== "=" || node.left?.type !== "Identifier") return;
      const src = clockSourceOfExpression(node.right, aliases);
      if (src) {
        // First-write-wins — matches the rest of the alias model.
        if (!clockBindings.has(node.left.name)) clockBindings.set(node.left.name, src);
      }
    },
  });

  if (clockBindings.size === 0) return;

  const COMPARE_OPS = new Set([">", ">=", "<", "<="]);
  walkSimple(program, {
    BinaryExpression(node: any) {
      if (!COMPARE_OPS.has(node.operator)) return;
      const { sub, threshold } = splitCompareAgainstLiteral(node);
      if (!sub || threshold === null) return;
      if (sub.operator !== "-") return;
      const leftSrc = clockSourceOfIdentifierOrCall(sub.left, aliases, clockBindings);
      const rightSrc = clockSourceOfIdentifierOrCall(sub.right, aliases, clockBindings);
      if (!leftSrc || !rightSrc) return;
      if (leftSrc !== rightSrc) return; // cross-clock falls under clock-skew
      hazards.push({
        kind: "timing-delta-probe",
        loc: locOf(node),
        snippet: sliceSnippet(source, node, snippetLength),
        detail: `Two ${leftSrc === "performance" ? "`performance.now()`" : "`Date.now()`"} reads subtracted and compared against literal ${threshold} — anti-debug / DevTools-pause probe (SoK §3.4 L4).`,
      });
    },
  });
}

function splitCompareAgainstLiteral(node: any): { sub: any | null; threshold: number | null } {
  const left = node.left;
  const right = node.right;
  if (isNumericLiteral(right) && left?.type === "BinaryExpression") {
    return { sub: left, threshold: numericLiteralValue(right) };
  }
  if (isNumericLiteral(left) && right?.type === "BinaryExpression") {
    return { sub: right, threshold: numericLiteralValue(left) };
  }
  return { sub: null, threshold: null };
}

function isNumericLiteral(node: any): boolean {
  if (!node) return false;
  if (node.type === "Literal" && typeof node.value === "number") return true;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument?.type === "Literal" &&
    typeof node.argument.value === "number"
  ) return true;
  return false;
}

function numericLiteralValue(node: any): number | null {
  if (node.type === "Literal") return typeof node.value === "number" ? node.value : null;
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const inner = numericLiteralValue(node.argument);
    return inner === null ? null : -inner;
  }
  return null;
}

function clockSourceOfIdentifierOrCall(
  node: any,
  aliases: AliasMap,
  clockBindings: Map<string, "performance" | "date">,
): "performance" | "date" | null {
  if (!node) return null;
  if (node.type === "Identifier") return clockBindings.get(node.name) ?? null;
  return clockSourceOfExpression(node, aliases);
}

/**
 * Detect the L4 CPU-pause / busy-loop probe from `2018 - JavaScript
 * Zero` and SoK §3.4. The pattern:
 *
 *     for (let i = 0; i < N; i++) {}          // N >= 100_000
 *
 * with no body — pure CPU burn used to detect debugger pauses or
 * fingerprint CPU class. Real code essentially never writes empty
 * tight loops, so the false-positive rate is near zero.
 *
 * We require:
 *   - test of form `i CMP LITERAL` where LITERAL >= 100_000
 *   - body is empty (empty block, empty statement) OR effectively a
 *     no-op
 */
function collectCpuPauseHazard(
  node: any,
  hazards: DynamicHazard[],
  source: string,
  snippetLength: number,
): void {
  const bound = forLoopUpperBound(node);
  if (bound === null || bound < 100_000) return;
  if (!isEmptyLoopBody(node.body)) return;
  hazards.push({
    kind: "cpu-pause-probe",
    loc: locOf(node),
    snippet: sliceSnippet(source, node, snippetLength),
    detail: `Empty busy-loop with bound ${bound} — CPU-burn / debugger-pause probe. Used to detect DevTools pauses and fingerprint CPU class (\`2018 - JavaScript Zero\`).`,
  });
}

function forLoopUpperBound(forNode: any): number | null {
  const test = forNode.test;
  if (!test || test.type !== "BinaryExpression") return null;
  if (!["<", "<=", ">", ">="].includes(test.operator)) return null;
  if (isNumericLiteral(test.right)) return numericLiteralValue(test.right);
  if (isNumericLiteral(test.left)) return numericLiteralValue(test.left);
  return null;
}

/**
 * Resolve `Reflect.get(ROOT, "prop")` and
 * `Object.getOwnPropertyDescriptor(proto, "key").get.call(receiver)`
 * into synthetic accesses on the underlying chain.
 *
 * The first form is the standard stealth-bypass trampoline used to
 * read fingerprint-relevant properties while avoiding direct
 * MemberExpression syntax that a defender's lint pass might scan for.
 *
 * The second form is the SoK §3.4 "stealth getter call" used by both
 * CreepJS-style introspection and Botguard-class detectors to invoke
 * the *original*, un-patched getter — the analyst's instrumented
 * shim is bypassed entirely.
 *
 * We only synthesize when:
 *   - the receiver / property are statically resolvable, AND
 *   - the receiver collapses to a {@link watchedRoots}-shaped chain
 *     OR a chain that {@link buildAliases} has already mapped.
 */
function resolveTrampolines(
  program: any,
  aliases: AliasMap,
  accesses: RawAccess[],
  source: string,
  snippetLength: number,
): void {
  walkSimple(program, {
    CallExpression(node: any) {
      const synth = synthesizeTrampolineAccess(node, aliases);
      if (!synth) return;
      const stripped = stripGlobalHead(synth.chain);
      accesses.push({
        chain: stripped.length ? stripped : synth.chain,
        called: false,
        loc: locOf(node),
        snippet: sliceSnippet(source, node, snippetLength),
        resolvedThroughObfuscation: true,
        hasDynamicSegment: false,
      });
    },
  });
}

function synthesizeTrampolineAccess(
  call: any,
  aliases: AliasMap,
): { chain: (string | null)[] } | null {
  const callee = call.callee;
  if (!callee) return null;

  // Form 1: Reflect.get(target, "prop")
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object?.type === "Identifier" &&
    callee.object.name === "Reflect" &&
    callee.property?.type === "Identifier" &&
    callee.property.name === "get"
  ) {
    const target = call.arguments?.[0];
    const prop = call.arguments?.[1];
    const targetChain = chainOfRoot(target, aliases);
    const propStr = resolveStaticString(prop, aliases);
    if (!targetChain || propStr === null) return null;
    return { chain: [...targetChain, propStr] };
  }

  // Form 2: Object.getOwnPropertyDescriptor(proto, "key").get.call(receiver)
  // We collapse to `proto.key` on the chain so that catalog wildcards
  // and chain-prefix matches still fire. The `.get.call(receiver)`
  // suffix is the trampoline; we model it as a non-called read of the
  // underlying property because that's how detectors actually use it.
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property?.type === "Identifier" &&
    callee.property.name === "call" &&
    callee.object?.type === "MemberExpression" &&
    !callee.object.computed &&
    callee.object.property?.type === "Identifier" &&
    callee.object.property.name === "get" &&
    callee.object.object?.type === "CallExpression"
  ) {
    const inner = callee.object.object;
    const innerCallee = inner.callee;
    if (
      innerCallee?.type === "MemberExpression" &&
      !innerCallee.computed &&
      innerCallee.object?.type === "Identifier" &&
      innerCallee.object.name === "Object" &&
      innerCallee.property?.type === "Identifier" &&
      innerCallee.property.name === "getOwnPropertyDescriptor"
    ) {
      const proto = inner.arguments?.[0];
      const key = inner.arguments?.[1];
      const protoChain = chainOfRoot(proto, aliases);
      const keyStr = resolveStaticString(key, aliases);
      if (!protoChain || keyStr === null) return null;
      return { chain: [...protoChain, keyStr] };
    }
  }

  return null;
}

function isEmptyLoopBody(body: any): boolean {
  if (!body) return true;
  if (body.type === "EmptyStatement") return true;
  if (body.type === "BlockStatement") return (body.body ?? []).length === 0;
  return false;
}

function chainOfRoot(node: any, aliases: AliasMap): string[] | null {
  if (!node) return null;
  if (node.type === "Identifier") {
    const aliased = aliases.chains.get(node.name);
    return aliased ? [...aliased] : [node.name];
  }
  if (node.type === "MemberExpression") {
    const head = chainOfRoot(node.object, aliases);
    if (!head) return null;
    const tail = resolveProperty(node, aliases);
    if (tail === null) return null;
    return [...head, tail];
  }
  return null;
}

function identifierName(node: any, aliases: AliasMap): string | null {
  if (!node) return null;
  if (node.type === "Identifier") {
    const aliased = aliases.chains.get(node.name);
    if (aliased && aliased.length === 1) return aliased[0] ?? node.name;
    return node.name;
  }
  if (node.type === "MemberExpression") {
    return resolveProperty(node, aliases);
  }
  return null;
}

function firstStringArgOf(parent: any, aliases: AliasMap): string | null | undefined {
  if (parent.type !== "CallExpression" && parent.type !== "NewExpression") return undefined;
  const first = parent.arguments?.[0];
  if (!first) return undefined;
  return resolveStaticString(first, aliases);
}

function sliceSnippet(source: string, node: any, max: number): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return "";
  const raw = source.slice(node.start, node.end);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}
