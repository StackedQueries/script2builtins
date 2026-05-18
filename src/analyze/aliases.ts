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
}

export function buildAliases(program: Program): AliasMap {
  const aliases: AliasMap = { chains: new Map(), strings: new Map() };

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

/** Reduce an expression to a string literal when possible. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveStaticString(node: any, aliases: AliasMap): string | null {
  if (!node || typeof node !== "object") return null;
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? (node.value as string) : null;
    case "TemplateLiteral":
      if (node.expressions.length !== 0) return null;
      return (node.quasis as Array<{ value: { cooked?: string; raw?: string } }>)
        .map((q) => q.value.cooked ?? "")
        .join("");
    case "TaggedTemplateExpression": {
      // `String.raw\`webdriver\`` and identity-tagged template literals
      // (`id\`webdriver\``) reduce to their underlying string in commercial
      // detectors that want to dodge naive substring scans. We accept the
      // tag when it's the well-known `String.raw` global or an
      // identity-named local (heuristic: tag is a single identifier or a
      // 2-segment chain ending in `raw`). (IMPROVEMENTS.md C5.)
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
    case "BinaryExpression": {
      if (node.operator !== "+") return null;
      const l = resolveStaticString(node.left, aliases);
      const r = resolveStaticString(node.right, aliases);
      if (l === null || r === null) return null;
      return l + r;
    }
    case "Identifier": {
      const aliased = aliases.strings.get(node.name as string);
      return aliased ?? null;
    }
    case "CallExpression": {
      // Constant-fold `String.fromCharCode(N1, N2, …)` and
      // `String.fromCharCode.apply(null, [N1, …])` when every argument
      // is an integer literal. Lets the catalog match obfuscated probes
      // like `navigator[String.fromCharCode(119,101,98,…)]`. (C3.)
      return resolveFromCharCode(node);
    }
    default:
      return null;
  }
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
