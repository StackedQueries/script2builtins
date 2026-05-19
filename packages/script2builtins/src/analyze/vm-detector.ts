import type { Program } from "acorn";
import { simple as walkSimple } from "acorn-walk";
import type { StructuralFinding, Location } from "../types.js";
import { locOf, snippetOf } from "./util.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Detect register/stack-VM bytecode dispatchers (Botguard / Kasada /
 * Hyperion class anti-bot blobs).
 *
 * The canonical signature, per the Kits Kärneriks Botguard analysis:
 *
 *   1. A large numeric `Array` literal (≥ MIN_BYTECODE entries, mostly
 *      small ints) — the bytecode itself.
 *   2. A dispatch loop: a function whose body contains a `switch` over
 *      a counter, where the case arms call indexed entries of a function
 *      table.
 *   3. Optional: a `String.fromCharCode.apply(null, [...])` reconstruction
 *      of opcode names (Botguard's `LOADSTRING` pattern).
 *
 * We require AT LEAST the bytecode + dispatch signal — pure
 * fingerprinters that happen to use a switch don't trigger.
 *
 * Returns at most one `StructuralFinding` (kind `"vm-bytecode"`) at the
 * largest dispatch site found.
 */

/** Smallest array length we'll consider "bytecode-shaped." */
const MIN_BYTECODE_ENTRIES = 1024;
/** Fraction of entries that must be small-int Literals. */
const SMALLINT_RATIO = 0.8;
/** Small-int range: opcodes / operands tend to live in [-256, 65535]. */
const SMALLINT_MIN = -256;
const SMALLINT_MAX = 65535;
/** Smallest switch we'll consider a "dispatch loop." */
const MIN_DISPATCH_ARMS = 8;

interface BytecodeHit {
  entries: number;
  bytes: number;
  loc: Location | null;
}

interface DispatchHit {
  arms: number;
  indexedFunctionCallArms: number;
  loc: Location | null;
  snippet: string;
}

export function detectVmBytecode(program: Program, source: string): StructuralFinding | null {
  const bytecodes: BytecodeHit[] = [];
  const dispatches: DispatchHit[] = [];
  let fromCharCodeApplyCount = 0;

  walkSimple(program, {
    ArrayExpression(node) {
      const arr = node as any;
      const elts: any[] = arr.elements ?? [];
      if (elts.length < MIN_BYTECODE_ENTRIES) return;
      let small = 0;
      for (const e of elts) {
        if (!e) continue;
        // Unary -N literal counts.
        if (
          e.type === "UnaryExpression" &&
          e.operator === "-" &&
          e.argument?.type === "Literal" &&
          typeof e.argument.value === "number"
        ) {
          const v = -e.argument.value;
          if (Number.isInteger(v) && v >= SMALLINT_MIN && v <= SMALLINT_MAX) small++;
          continue;
        }
        if (
          e.type === "Literal" &&
          typeof e.value === "number" &&
          Number.isInteger(e.value) &&
          e.value >= SMALLINT_MIN &&
          e.value <= SMALLINT_MAX
        ) {
          small++;
        }
      }
      if (small / elts.length >= SMALLINT_RATIO) {
        const bytes =
          typeof arr.end === "number" && typeof arr.start === "number" ? arr.end - arr.start : 0;
        bytecodes.push({ entries: elts.length, bytes, loc: locOf(arr) });
      }
    },

    SwitchStatement(node) {
      const sw = node as any;
      const cases: any[] = sw.cases ?? [];
      if (cases.length < MIN_DISPATCH_ARMS) return;
      let indexedFunctionCallArms = 0;
      for (const c of cases) {
        if (caseLooksLikeDispatch(c)) indexedFunctionCallArms++;
      }
      if (indexedFunctionCallArms >= Math.max(MIN_DISPATCH_ARMS / 2, 4)) {
        dispatches.push({
          arms: cases.length,
          indexedFunctionCallArms,
          loc: locOf(sw),
          snippet: snippetOf(source, sw),
        });
      }
    },

    CallExpression(node) {
      const c = node as any;
      // String.fromCharCode.apply(...)
      const callee = c.callee;
      if (
        callee?.type === "MemberExpression" &&
        !callee.computed &&
        callee.property?.type === "Identifier" &&
        callee.property.name === "apply" &&
        callee.object?.type === "MemberExpression" &&
        !callee.object.computed &&
        callee.object.property?.type === "Identifier" &&
        callee.object.property.name === "fromCharCode" &&
        callee.object.object?.type === "Identifier" &&
        callee.object.object.name === "String"
      ) {
        fromCharCodeApplyCount++;
      }
    },
  });

  if (bytecodes.length === 0 || dispatches.length === 0) return null;

  // Pick the biggest signals to report.
  bytecodes.sort((a, b) => b.entries - a.entries);
  dispatches.sort((a, b) => b.arms - a.arms);
  const bc = bytecodes[0]!;
  const dp = dispatches[0]!;

  return {
    kind: "vm-bytecode",
    subkind: "opcode-dispatch",
    severity: "high",
    description:
      "Script contains a bytecode-VM signature: a large numeric array " +
      "paired with a switch-dispatched function table. Canonical Botguard " +
      "/ Kasada / Hyperion anti-bot pattern.",
    details: {
      bytecodeEntries: bc.entries,
      bytecodeBytes: bc.bytes,
      bytecodeLoc: bc.loc,
      dispatchSwitchArms: dp.arms,
      indexedFunctionCallArms: dp.indexedFunctionCallArms,
      bytecodeArrays: bytecodes.length,
      dispatchSwitches: dispatches.length,
      fromCharCodeApplyCount,
    },
    loc: dp.loc,
    snippet: dp.snippet,
  };
}

/**
 * A case arm looks like dispatch when its body contains a call whose
 * callee is a computed member expression (`fnTable[op]` / `this[op]` /
 * `obj[idx]`). We accept call OR return of a call.
 */
function caseLooksLikeDispatch(c: any): boolean {
  for (const stmt of c.consequent ?? []) {
    if (statementHasIndexedCall(stmt)) return true;
  }
  return false;
}

function statementHasIndexedCall(stmt: any): boolean {
  if (!stmt) return false;
  switch (stmt.type) {
    case "ExpressionStatement":
      return expressionHasIndexedCall(stmt.expression);
    case "ReturnStatement":
      return expressionHasIndexedCall(stmt.argument);
    case "VariableDeclaration":
      for (const d of stmt.declarations ?? []) {
        if (expressionHasIndexedCall(d.init)) return true;
      }
      return false;
    case "BlockStatement":
      for (const s of stmt.body ?? []) {
        if (statementHasIndexedCall(s)) return true;
      }
      return false;
    case "IfStatement":
      return (
        expressionHasIndexedCall(stmt.test) ||
        statementHasIndexedCall(stmt.consequent) ||
        statementHasIndexedCall(stmt.alternate)
      );
    default:
      return false;
  }
}

function expressionHasIndexedCall(expr: any): boolean {
  if (!expr) return false;
  if (expr.type === "CallExpression") {
    const callee = expr.callee;
    if (callee?.type === "MemberExpression" && callee.computed) return true;
    // Also match calls like `fnTable[op](args)` nested as part of a
    // larger expression (e.g., `return fnTable[op](args)`); the callee
    // check above already covers it.
  }
  if (expr.type === "AssignmentExpression") {
    return expressionHasIndexedCall(expr.right);
  }
  if (expr.type === "SequenceExpression") {
    for (const e of expr.expressions ?? []) {
      if (expressionHasIndexedCall(e)) return true;
    }
  }
  if (expr.type === "ConditionalExpression") {
    return (
      expressionHasIndexedCall(expr.consequent) ||
      expressionHasIndexedCall(expr.alternate)
    );
  }
  if (expr.type === "LogicalExpression") {
    return expressionHasIndexedCall(expr.left) || expressionHasIndexedCall(expr.right);
  }
  return false;
}

