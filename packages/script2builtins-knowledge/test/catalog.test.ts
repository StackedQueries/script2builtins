import { describe, it, expect } from "vitest";
import {
  ALL_APIS,
  watchedRoots,
  knownEndpoints,
  classifyEndpointUrl,
} from "../src/index.js";

describe("script2builtins-knowledge", () => {
  it("ALL_APIS is a non-empty catalog of well-formed entries", () => {
    expect(ALL_APIS.length).toBeGreaterThan(100);
    for (const api of ALL_APIS) {
      expect(typeof api.key).toBe("string");
      expect(api.key.length).toBeGreaterThan(0);
      expect(typeof api.category).toBe("string");
      expect(["info", "low", "medium", "high"]).toContain(api.severity);
      if (api.layer !== undefined) {
        expect(["L1a", "L1b", "L2", "L3", "L4"]).toContain(api.layer);
      }
    }
  });

  it("catalog (key + argMatch) entries are unique", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const api of ALL_APIS) {
      const id = `${api.key}::${(api.argMatch ?? []).slice().sort().join("|")}`;
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    expect(dupes).toEqual([]);
  });

  it("watchedRoots covers every non-wildcard root in the catalog", () => {
    const roots = watchedRoots();
    for (const api of ALL_APIS) {
      const head = api.key.split(".")[0];
      if (head && head !== "*") expect(roots.has(head)).toBe(true);
    }
  });

  it("knownEndpoints is a non-empty array", () => {
    expect(Array.isArray(knownEndpoints)).toBe(true);
    expect(knownEndpoints.length).toBeGreaterThan(0);
  });

  it("classifyEndpointUrl returns null for an unknown host", () => {
    expect(classifyEndpointUrl("https://no-such-endpoint.example.invalid/x")).toBeNull();
  });
});
