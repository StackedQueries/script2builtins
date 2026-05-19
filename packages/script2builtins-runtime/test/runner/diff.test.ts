/**
 * Tests for the `s2b diff` symmetric-diff helper (D11). The diff is
 * pure data-in/data-out so we don't need a browser — synthesize two
 * `RuntimeReport`-shaped objects and assert the report shape.
 */
import { describe, it, expect } from "vitest";
import { diffReports, renderDiffText } from "../../src/runner/diff.js";
import type { RuntimeReport } from "../../src/types.js";

function blankReport(overrides: Partial<RuntimeReport> = {}): RuntimeReport {
  return {
    reportVersion: "1.0.0",
    catalogVersion: "script2builtins@0.1.0",
    trapScriptSha256: "a".repeat(64),
    stealthScriptSha256: null,
    target: "https://x.example/",
    runId: "run-1",
    startedAt: "2026-05-19T00:00:00Z",
    endedAt: "2026-05-19T00:00:10Z",
    navError: null,
    harnessMode: "url",
    events: [],
    scripts: [],
    reconstructedAccesses: [],
    reconstructedSinks: [],
    hazards: [],
    findings: [],
    byCategory: {},
    summary: {
      totalScripts: 0,
      networkScripts: 0,
      inlineScripts: 0,
      srcdocScripts: 0,
      evalScripts: 0,
      totalAccesses: 0,
      runtimeAccesses: 0,
      staticAccesses: 0,
      knownAccesses: 0,
      botDetectionTells: 0,
      sinkCount: 0,
      leakedApiCount: 0,
      runtimeCategories: [],
      runtimeOnlyKeys: [],
      staticOnlyKeys: [],
      preExistingPages: 0,
      bufferOverflows: 0,
      bufferOverflowsByKind: { access: 0, sink: 0, hazard: 0 },
      pushFlushes: 0,
      pushedEvents: 0,
    },
    ...overrides,
  } as RuntimeReport;
}

function mkFinding(
  key: string,
  severity: "info" | "low" | "medium" | "high",
  opts: { count?: number; callSites?: number; provenance?: "static" | "runtime" | "static+runtime" } = {},
): any {
  return {
    api: { key, category: "navigator", severity, botDetectionTell: severity === "high" },
    hits: [],
    count: opts.count ?? 1,
    provenance: opts.provenance ?? "static+runtime",
    callSites: opts.callSites ?? 1,
    sampleStacks: [],
  };
}

function mkSink(kind: string, url: string, provider: string | null = null): any {
  return {
    kind,
    url,
    method: "POST",
    headers: {},
    loc: null,
    snippet: "",
    payload: null,
    provider,
  };
}

describe("diffReports", () => {
  it("flags new findings on B and removed findings on A", () => {
    const a = blankReport({
      findings: [mkFinding("navigator.userAgent", "low")],
    });
    const b = blankReport({
      findings: [
        mkFinding("navigator.userAgent", "low"),
        mkFinding("canvas.toDataURL", "high"),
      ],
    });
    const d = diffReports({ slug: "a.json", report: a }, { slug: "b.json", report: b });
    expect(d.newFindings.map((f) => f.api.key)).toEqual(["canvas.toDataURL"]);
    expect(d.removedFindings).toHaveLength(0);
  });

  it("flags shifted findings when count or callSites changed ≥ 2×", () => {
    const a = blankReport({
      findings: [mkFinding("navigator.userAgent", "low", { count: 1, callSites: 1 })],
    });
    const b = blankReport({
      findings: [mkFinding("navigator.userAgent", "low", { count: 5, callSites: 3 })],
    });
    const d = diffReports({ slug: "a.json", report: a }, { slug: "b.json", report: b });
    expect(d.shiftedFindings).toHaveLength(1);
    expect(d.shiftedFindings[0]!.key).toBe("navigator.userAgent");
    expect(d.shiftedFindings[0]!.a).toEqual({ count: 1, callSites: 1 });
    expect(d.shiftedFindings[0]!.b).toEqual({ count: 5, callSites: 3 });
  });

  it("does not flag small shifts (<2×)", () => {
    const a = blankReport({
      findings: [mkFinding("navigator.userAgent", "low", { count: 4, callSites: 2 })],
    });
    const b = blankReport({
      findings: [mkFinding("navigator.userAgent", "low", { count: 5, callSites: 3 })],
    });
    const d = diffReports({ slug: "a.json", report: a }, { slug: "b.json", report: b });
    expect(d.shiftedFindings).toHaveLength(0);
  });

  it("diffs sinks by (kind, url) tuple", () => {
    const a = blankReport({
      reconstructedSinks: [mkSink("fetch", "https://a/")],
    });
    const b = blankReport({
      reconstructedSinks: [mkSink("fetch", "https://a/"), mkSink("fetch", "https://b/")],
    });
    const d = diffReports({ slug: "a.json", report: a }, { slug: "b.json", report: b });
    expect(d.newSinks.map((s) => s.url)).toEqual(["https://b/"]);
    expect(d.removedSinks).toHaveLength(0);
  });

  it("emits new/removed provider slugs", () => {
    const a = blankReport({
      reconstructedSinks: [mkSink("fetch", "https://x/", "DataDome")],
    });
    const b = blankReport({
      reconstructedSinks: [
        mkSink("fetch", "https://x/", "DataDome"),
        mkSink("fetch", "https://y/", "Cloudflare Turnstile"),
      ],
    });
    const d = diffReports({ slug: "a.json", report: a }, { slug: "b.json", report: b });
    expect(d.newProviders).toEqual(["Cloudflare Turnstile"]);
    expect(d.removedProviders).toEqual([]);
  });

  it("warns on catalog drift", () => {
    const a = blankReport({ catalogVersion: "script2builtins@0.1.0" });
    const b = blankReport({ catalogVersion: "script2builtins@0.2.0" });
    const d = diffReports({ slug: "a.json", report: a }, { slug: "b.json", report: b });
    expect(d.catalogDrift.same).toBe(false);
    expect(d.catalogDrift.a).toBe("script2builtins@0.1.0");
    expect(d.catalogDrift.b).toBe("script2builtins@0.2.0");
    const out = renderDiffText(d, { noColor: true });
    expect(out).toContain("catalog drift");
  });

  it("renders a readable text block without color when noColor is set", () => {
    const a = blankReport({
      findings: [mkFinding("navigator.userAgent", "low")],
      reconstructedSinks: [mkSink("fetch", "https://a/")],
    });
    const b = blankReport({
      findings: [
        mkFinding("navigator.userAgent", "low"),
        mkFinding("canvas.toDataURL", "high"),
      ],
      reconstructedSinks: [
        mkSink("fetch", "https://a/"),
        mkSink("fetch", "https://b/", "Akamai"),
      ],
    });
    const d = diffReports({ slug: "baseline", report: a }, { slug: "new", report: b });
    const out = renderDiffText(d, { noColor: true });
    expect(out).toContain("script2builtins-runtime — run diff");
    expect(out).toContain("baseline");
    expect(out).toContain("new");
    expect(out).toContain("canvas.toDataURL");
    expect(out).toContain("https://b/");
    expect(out).toContain("Akamai");
    // ANSI sequences absent.
    expect(out.includes("\x1b[")).toBe(false);
  });
});
