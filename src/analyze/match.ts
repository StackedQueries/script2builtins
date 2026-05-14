import type { ApiDefinition, RawAccess, Finding } from "../types.js";

interface CompiledKey {
  api: ApiDefinition;
  parts: string[];
  isWildcard: boolean;
}

function compile(api: ApiDefinition): CompiledKey {
  const parts = api.key.split(".");
  return {
    api,
    parts,
    isWildcard: parts[0] === "*",
  };
}

function chainMatches(chain: (string | null)[], compiled: CompiledKey): boolean {
  if (compiled.isWildcard) {
    const tail = compiled.parts.slice(1);
    if (tail.length === 0) return false;
    if (chain.length < tail.length) return false;
    const start = chain.length - tail.length;
    for (let i = 0; i < tail.length; i++) {
      if (chain[start + i] !== tail[i]) return false;
    }
    return true;
  }
  if (chain.length < compiled.parts.length) return false;
  for (let i = 0; i < compiled.parts.length; i++) {
    if (chain[i] !== compiled.parts[i]) return false;
  }
  return true;
}

function argMatches(access: RawAccess, api: ApiDefinition): boolean {
  if (!api.argMatch || api.argMatch.length === 0) return true;
  if (!access.called) return false;
  if (access.firstStringArg == null) return false;
  return api.argMatch.includes(access.firstStringArg);
}

/**
 * Match each raw access against the API catalog.
 *
 * An access can satisfy multiple definitions (e.g., `*.toString` and
 * `Function.prototype.toString`); we keep all matches so the report
 * shows every applicable interpretation.
 *
 * Returns:
 * - `findings`: array of `{ api, hits, count }`, sorted by severity
 *   (high → info), then category, then key.
 * - `unknown`: raw accesses that didn't match any catalog entry.
 *
 * The catalog is normally {@link ALL_APIS} from `script2builtins/knowledge`,
 * but you can pass a filtered or extended array — this is the seam for
 * custom rules.
 */
export function matchAccesses(
  accesses: RawAccess[],
  apis: ApiDefinition[],
): { findings: Finding[]; unknown: RawAccess[] } {
  const compiled = apis.map(compile);
  const buckets = new Map<ApiDefinition, RawAccess[]>();
  const matchedAccesses = new WeakSet<RawAccess>();

  for (const access of accesses) {
    for (const c of compiled) {
      if (!chainMatches(access.chain, c)) continue;
      if (!argMatches(access, c.api)) continue;
      let bucket = buckets.get(c.api);
      if (!bucket) {
        bucket = [];
        buckets.set(c.api, bucket);
      }
      bucket.push(access);
      matchedAccesses.add(access);
    }
  }

  const findings: Finding[] = [];
  for (const [api, hits] of buckets) {
    findings.push({ api, hits, count: hits.length });
  }

  // Stable sort: high severity first, then by category, then by key.
  const sevRank: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => {
    const sa = sevRank[a.api.severity] ?? 9;
    const sb = sevRank[b.api.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    if (a.api.category !== b.api.category) return a.api.category.localeCompare(b.api.category);
    return a.api.key.localeCompare(b.api.key);
  });

  const unknown = accesses.filter((a) => !matchedAccesses.has(a));
  return { findings, unknown };
}
