import { describe, it, expect } from "vitest";
import { mergeFindings, runtimeOnlyKeys, staticOnlyKeys } from "../../src/runner/merge.js";
import type { Finding, RawAccess } from "script2builtins/types";

function rawHit(snippet = "foo"): RawAccess {
  return {
    chain: ["navigator", "webdriver"],
    called: false,
    loc: null,
    snippet,
    resolvedThroughObfuscation: false,
    hasDynamicSegment: false,
  };
}

function finding(key: string, count: number, hits: RawAccess[]): Finding {
  return {
    api: {
      key,
      category: "navigator",
      description: "test",
      severity: "high",
      botDetectionTell: true,
    },
    hits,
    count,
  };
}

describe("mergeFindings", () => {
  it("marks static-only findings provenance=static", () => {
    const merged = mergeFindings({
      staticFindings: [finding("navigator.brave", 1, [rawHit()])],
      runtimeFindings: [],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.provenance).toBe("static");
    expect(merged[0]!.callSites).toBe(0);
  });

  it("marks runtime-only findings provenance=runtime", () => {
    const merged = mergeFindings({
      staticFindings: [],
      runtimeFindings: [finding("navigator.webdriver", 5, [rawHit("stack1"), rawHit("stack2")])],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.provenance).toBe("runtime");
    expect(merged[0]!.callSites).toBe(2);
  });

  it("merges static and runtime entries for the same key", () => {
    const merged = mergeFindings({
      staticFindings: [finding("navigator.userAgent", 3, [rawHit("a")])],
      runtimeFindings: [finding("navigator.userAgent", 8, [rawHit("b"), rawHit("c"), rawHit("b")])],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.provenance).toBe("static+runtime");
    expect(merged[0]!.count).toBe(11);
    expect(merged[0]!.callSites).toBe(2); // "b" deduplicated
    expect(merged[0]!.sampleStacks).toEqual(["b", "c"]);
  });

  it("sorts by severity then count", () => {
    const merged = mergeFindings({
      staticFindings: [
        {
          api: { key: "a", category: "x", description: "", severity: "low" },
          hits: [],
          count: 100,
        },
        {
          api: { key: "b", category: "x", description: "", severity: "high" },
          hits: [],
          count: 1,
        },
      ],
      runtimeFindings: [],
    });
    expect(merged[0]!.api.key).toBe("b"); // high before low
  });

  it("derives runtimeOnly / staticOnly gap lists", () => {
    const merged = mergeFindings({
      staticFindings: [finding("static.only", 1, [rawHit()])],
      runtimeFindings: [finding("runtime.only", 1, [rawHit()])],
    });
    expect(runtimeOnlyKeys(merged)).toEqual(["runtime.only"]);
    expect(staticOnlyKeys(merged)).toEqual(["static.only"]);
  });
});
