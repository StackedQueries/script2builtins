import type { Program } from "acorn";
import { ancestor as walkAncestor } from "acorn-walk";
import type { RawAccess, DynamicHazard, Location } from "../types.js";
import {
  buildAliases,
  resolveProperty,
  resolveStaticString,
  type AliasMap,
} from "./aliases.js";

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
        loc: extractLoc(member),
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
        loc: extractLoc(ident),
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
        loc: extractLoc(node as any),
        snippet: sliceSnippet(opts.source, node as any, opts.snippetLength),
        detail: "`with` blocks dynamically scope identifier resolution; static analysis cannot follow accesses inside.",
      });
    },

    ImportExpression(node) {
      hazards.push({
        kind: "import-call",
        loc: extractLoc(node as any),
        snippet: sliceSnippet(opts.source, node as any, opts.snippetLength),
        detail: "Dynamic `import()` may pull in additional fingerprinting code at runtime.",
      });
    },
  });

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
      hazards.push({
        kind: "Function",
        loc: extractLoc(call),
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
    hazards.push({
      kind: "eval",
      loc: extractLoc(call),
      snippet: sliceSnippet(source, call, snippetLength),
      detail: "`eval` runs arbitrary source at runtime — content is invisible to static analysis.",
    });
    return;
  }
  if (calleeName === "Function") {
    hazards.push({
      kind: "Function",
      loc: extractLoc(call),
      snippet: sliceSnippet(source, call, snippetLength),
      detail: "`Function` constructor compiles a string into a function — common eval-equivalent in fingerprinting blobs.",
    });
    return;
  }
  if (calleeName === "setTimeout" || calleeName === "setInterval") {
    if (firstArg && resolveStaticString(firstArg, aliases) !== null) {
      hazards.push({
        kind: calleeName === "setTimeout" ? "setTimeout-string" : "setInterval-string",
        loc: extractLoc(call),
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
          loc: extractLoc(call),
          snippet: sliceSnippet(source, call, snippetLength),
          detail: "`document.write` can inject script tags that load further fingerprinting code.",
        });
      }
    }
  }
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

function extractLoc(node: any): Location | null {
  return node?.loc ?? null;
}

function sliceSnippet(source: string, node: any, max: number): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return "";
  const raw = source.slice(node.start, node.end);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}
