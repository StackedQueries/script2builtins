/**
 * Unit checks for the `index.html` summary (D12). We don't open the
 * page — just assert the renderer's output is well-formed HTML5, has
 * the expected sections, and is XSS-safe against the input shape.
 */
import { describe, it, expect } from "vitest";
import { renderHtmlIndex } from "../../src/report/html.js";
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

describe("renderHtmlIndex", () => {
  it("produces a well-formed HTML5 document with all expected sections", () => {
    const r = blankReport({
      findings: [
        {
          api: {
            key: "navigator.userAgent",
            category: "navigator",
            severity: "low",
            botDetectionTell: false,
          },
          hits: [],
          count: 2,
          provenance: "static+runtime",
          callSites: 1,
          sampleStacks: [],
        } as any,
      ],
      reconstructedSinks: [
        {
          kind: "fetch",
          url: "https://api.example/telemetry",
          method: "POST",
          headers: {},
          loc: null,
          snippet: "",
          payload: null,
          provider: "DataDome",
          originatingScriptSha256: "a".repeat(64),
        } as any,
      ],
    });
    const html = renderHtmlIndex(r, {
      jsonReportHref: "./report.json",
      textReportHref: "./report.txt",
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("script2builtins-runtime");
    expect(html).toContain("https://x.example/");
    expect(html).toContain("findings");
    expect(html).toContain("navigator.userAgent");
    expect(html).toContain("DataDome");
    // Companion artifact links present.
    expect(html).toContain('href="./report.json"');
    expect(html).toContain('href="./report.txt"');
    // Stealth banner not present when sha is null.
    expect(html).not.toMatch(/<dt>stealth<\/dt>/);
  });

  it("includes the stealth row when a stealth sha is present", () => {
    const r = blankReport({ stealthScriptSha256: "b".repeat(64) });
    const html = renderHtmlIndex(r);
    expect(html).toContain("<dt>stealth</dt>");
    expect(html).toContain("b".repeat(16));
  });

  it("XSS-escapes target URL, finding keys, and snippet text", () => {
    const r = blankReport({
      target: "https://x.example/<script>alert(1)</script>",
      navError: "<img src=x onerror=alert(1)>",
      findings: [
        {
          api: {
            key: "evil<key>",
            category: "<cat>",
            severity: "high",
            botDetectionTell: true,
          },
          hits: [],
          count: 1,
          provenance: "runtime",
          callSites: 1,
          sampleStacks: [],
        } as any,
      ],
    });
    const html = renderHtmlIndex(r);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("evil&lt;key&gt;");
  });

  it("renders captured-script rows with relative file links", () => {
    const r = blankReport({
      scripts: [
        {
          name: "https://x.example/fp.js",
          sha256: "c".repeat(64),
          bytes: 1234,
          acquisition: "network",
          frames: ["https://x.example/"],
          staticReport: {
            source: { name: "fp.js", bytes: 1234, lines: 30 },
            parse: { ok: true, sourceType: "script", errors: [] },
            findings: [],
            byCategory: {},
            hazards: [],
            networkSinks: [],
            structural: [],
            unknownAccesses: [],
            summary: {
              totalAccesses: 0,
              knownAccesses: 0,
              botDetectionTells: 3,
              fingerprintingDensityPerKb: 0,
              categories: [],
              sinkCount: 0,
              leakedApiCount: 0,
              providers: {},
              vmBytecodeDetected: false,
              antiDebugTells: 0,
              consistencyChecks: 0,
            },
          } as any,
          eventRange: [null, null],
          trapCoverage: 0.75,
          savedTo: "/abs/out/scripts/abc123_fp.js",
        } as any,
      ],
    });
    const html = renderHtmlIndex(r);
    expect(html).toContain("scripts captured");
    expect(html).toContain("./scripts/abc123_fp.js");
    expect(html).toContain("75%");
    // Bot-detection-tells count surfaces from the static report.
    expect(html).toContain("<strong>3</strong>");
  });
});
