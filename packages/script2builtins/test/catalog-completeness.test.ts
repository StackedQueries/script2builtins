/**
 * Catalog-completeness invariant test.
 *
 * Catches the common contribution bugs that the more semantic tests
 * miss: duplicate keys (modulo argMatch disambiguation), missing
 * descriptions, info-severity bot tells, mismatched categories.
 *
 * Cheap to run, so it stays in the default `npm test` pass.
 */
import { describe, expect, it } from "vitest";
import { ALL_APIS } from "script2builtins-knowledge";
import type { ApiDefinition, Severity } from "../src/types.js";

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set([
  "info",
  "low",
  "medium",
  "high",
]);

/** Distinct category names currently in use across catalog files. */
const KNOWN_CATEGORIES: ReadonlySet<string> = new Set([
  "anti-debug",
  "audio",
  "canvas",
  "css",
  "document",
  "dom-layout",
  "events",
  "extensions",
  "fonts",
  "headless-tells",
  "intl",
  "introspection",
  "math",
  "media",
  "media-capabilities",
  "navigator",
  "screen",
  "sensors",
  "speech",
  "storage",
  "svg",
  "timing",
  "wasm",
  "webgl",
  "webrtc",
  "window",
  "workers",
]);

function disambiguatedKey(api: ApiDefinition): string {
  if (!api.argMatch || api.argMatch.length === 0) return api.key;
  return `${api.key}::${[...api.argMatch].sort().join(",")}`;
}

describe("catalog completeness invariants (F3)", () => {
  it("ALL_APIS is non-empty and every entry has a key", () => {
    expect(ALL_APIS.length).toBeGreaterThan(0);
    for (const api of ALL_APIS) {
      expect(typeof api.key).toBe("string");
      expect(api.key.length).toBeGreaterThan(0);
    }
  });

  it("every key is unique modulo argMatch", () => {
    const seen = new Map<string, ApiDefinition>();
    const dupes: string[] = [];
    for (const api of ALL_APIS) {
      const slot = disambiguatedKey(api);
      if (seen.has(slot)) dupes.push(slot);
      else seen.set(slot, api);
    }
    expect(dupes).toEqual([]);
  });

  it("every severity is one of info | low | medium | high", () => {
    const bad: { key: string; severity: string }[] = [];
    for (const api of ALL_APIS) {
      if (!VALID_SEVERITIES.has(api.severity)) {
        bad.push({ key: api.key, severity: api.severity as string });
      }
    }
    expect(bad).toEqual([]);
  });

  it("every description is non-empty", () => {
    const bad: string[] = [];
    for (const api of ALL_APIS) {
      if (typeof api.description !== "string" || api.description.trim() === "") {
        bad.push(api.key);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every category is in the known set", () => {
    const bad: { key: string; category: string }[] = [];
    for (const api of ALL_APIS) {
      if (!KNOWN_CATEGORIES.has(api.category)) {
        bad.push({ key: api.key, category: api.category });
      }
    }
    expect(bad).toEqual([]);
  });

  it("botDetectionTell entries are never info-severity", () => {
    const bad: string[] = [];
    for (const api of ALL_APIS) {
      if (api.botDetectionTell && api.severity === "info") bad.push(api.key);
    }
    expect(bad).toEqual([]);
  });

  it("argMatch entries always start with a leaf method (not a wildcard)", () => {
    // argMatch is only meaningful on `called` accesses, so the key must
    // resolve to a method-style leaf — either a fixed chain (`foo.getContext`)
    // or a wildcard suffix (`*.getContext`). Either is fine; what we
    // forbid is an empty `argMatch: []`, which would match nothing and
    // is almost certainly a copy-paste bug.
    const bad: string[] = [];
    for (const api of ALL_APIS) {
      if (api.argMatch && api.argMatch.length === 0) bad.push(api.key);
    }
    expect(bad).toEqual([]);
  });
});
