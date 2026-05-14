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
      return (node.quasis as Array<{ value: { cooked?: string } }>)
        .map((q) => q.value.cooked ?? "")
        .join("");
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
    default:
      return null;
  }
}
