/**
 * Merge static + runtime findings into a single annotated list.
 *
 * Rules:
 *   - Group by `api.key`.
 *   - Sum hit counts, union hit arrays.
 *   - Provenance = static / runtime / static+runtime depending on which
 *     side contributed.
 *   - Runtime stacks are deduplicated for the `callSites` field.
 */
import type { Finding } from "script2builtins/types";
import type { AnnotatedFinding, AnyRuntimeEvent } from "../types.js";

export interface MergeInput {
  staticFindings: Finding[];
  runtimeFindings: Finding[];
  /**
   * Runtime events keyed for stack lookup. When matching a runtime hit
   * back to its originating event, we use the index in
   * `runtimeFindings[i].hits[j]` against this array — but for stack
   * sampling we just inspect the hit's `snippet` field directly.
   */
  runtimeEvents?: AnyRuntimeEvent[];
}

export function mergeFindings(input: MergeInput): AnnotatedFinding[] {
  const byKey = new Map<
    string,
    {
      api: Finding["api"];
      staticHits: Finding["hits"];
      runtimeHits: Finding["hits"];
      count: number;
    }
  >();

  for (const f of input.staticFindings) {
    const slot = byKey.get(f.api.key);
    if (slot) {
      slot.staticHits = slot.staticHits.concat(f.hits);
      slot.count += f.count;
    } else {
      byKey.set(f.api.key, {
        api: f.api,
        staticHits: f.hits.slice(),
        runtimeHits: [],
        count: f.count,
      });
    }
  }
  for (const f of input.runtimeFindings) {
    const slot = byKey.get(f.api.key);
    if (slot) {
      slot.runtimeHits = slot.runtimeHits.concat(f.hits);
      slot.count += f.count;
    } else {
      byKey.set(f.api.key, {
        api: f.api,
        staticHits: [],
        runtimeHits: f.hits.slice(),
        count: f.count,
      });
    }
  }

  const out: AnnotatedFinding[] = [];
  for (const slot of byKey.values()) {
    const hasStatic = slot.staticHits.length > 0;
    const hasRuntime = slot.runtimeHits.length > 0;
    const provenance: AnnotatedFinding["provenance"] = hasStatic && hasRuntime
      ? "static+runtime"
      : hasStatic
        ? "static"
        : "runtime";
    const stacks = new Set<string>();
    const samples: string[] = [];
    for (const h of slot.runtimeHits) {
      if (!stacks.has(h.snippet)) {
        stacks.add(h.snippet);
        if (samples.length < 3) samples.push(h.snippet);
      }
    }
    out.push({
      api: slot.api,
      hits: slot.staticHits.concat(slot.runtimeHits),
      count: slot.count,
      provenance,
      callSites: stacks.size,
      sampleStacks: samples,
    });
  }

  out.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2, info: 3 };
    const da = sevOrder[a.api.severity];
    const db = sevOrder[b.api.severity];
    if (da !== db) return da - db;
    return b.count - a.count;
  });
  return out;
}

/**
 * Compute the keys that fired at runtime but never appeared in any
 * static report (the eval-blob / dynamic-key delta).
 */
export function runtimeOnlyKeys(merged: AnnotatedFinding[]): string[] {
  return merged.filter((f) => f.provenance === "runtime").map((f) => f.api.key).sort();
}

/**
 * Compute the keys that appeared statically but never fired at
 * runtime (the dead-code / untaken-branch delta).
 */
export function staticOnlyKeys(merged: AnnotatedFinding[]): string[] {
  return merged.filter((f) => f.provenance === "static").map((f) => f.api.key).sort();
}
