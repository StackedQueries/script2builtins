/**
 * Synthetic-fixture end-to-end tests (IMPROVEMENTS.md F1, partial).
 *
 * The original F1 ask was for real captured detector blobs
 * (`botguard-sample.js`, `datadome-sample.js`, etc.) anonymized and
 * checked in. That requires external fetch + legal review and is
 * still pending. As an interim, this file exercises the full pipeline
 * — `analyze()` → verdict line → summary fields → renderText output
 * — against hand-rolled synthetic fixtures that mimic the canonical
 * shape of each vendor's blob:
 *
 *   - botguard-synthetic.js          (Google Botguard / PO-Token)
 *   - datadome-synthetic.js          (DataDome telemetry)
 *   - cloudflare-turnstile-synthetic.js (Cloudflare Turnstile)
 *
 * These run as part of `npm test` (no gating) because they're small.
 * When real captured blobs land, gate the heavy ones via
 * S2B_RUN_E2E=1 — see the README.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze, renderText } from "../src/index.js";

const fixturesDir = resolve(__dirname, "fixtures", "synthetic");

function load(name: string): string {
  return readFileSync(resolve(fixturesDir, name), "utf8");
}

describe("F1 synthetic fixture: Google Botguard", () => {
  const src = load("botguard-synthetic.js");
  const r = analyze(src, { name: "botguard-synthetic.js" });

  it("parses cleanly", () => {
    expect(r.parse.ok).toBe(true);
  });

  it("classifies as a Google attestation endpoint (Botguard or PO Token WAA)", () => {
    const providers = Object.keys(r.summary.providers);
    const matched = providers.some((p) => p === "Google Botguard" || p === "Google PO Token (WAA)");
    expect(matched).toBe(true);
  });

  it("flips vmBytecodeDetected", () => {
    expect(r.summary.vmBytecodeDetected).toBe(true);
  });

  it("accumulates at least one anti-debug tell (obfuscated-eval / timing-delta / debugger)", () => {
    expect(r.summary.antiDebugTells).toBeGreaterThan(0);
  });

  it("fires the L3 anti-logger console.* catalog (medium-or-high tells)", () => {
    const consoleKeys = r.findings.filter((f) => f.api.category === "anti-debug").map((f) => f.api.key);
    expect(consoleKeys).toContain("console.log");
    expect(consoleKeys).toContain("console.debug");
  });

  it("verdict line names a Google attestation provider", () => {
    const text = renderText(r, { noColor: true, showHits: false });
    expect(text).toMatch(/verdict.*Google (Botguard|PO Token)/);
  });

  it("at least one network sink hits the Botguard/PO-Token endpoint table", () => {
    const sinks = r.networkSinks.filter(
      (s) => s.provider === "Google Botguard" || s.provider === "Google PO Token (WAA)",
    );
    expect(sinks.length).toBeGreaterThan(0);
  });
});

describe("F1 synthetic fixture: DataDome", () => {
  const src = load("datadome-synthetic.js");
  const r = analyze(src, { name: "datadome-synthetic.js" });

  it("parses cleanly", () => {
    expect(r.parse.ok).toBe(true);
  });

  it("classifies as DataDome via the provider table", () => {
    expect(r.summary.providers).toHaveProperty("DataDome");
  });

  it("emits a consistency-check structural finding (UA vs UA-CH platform)", () => {
    const consistency = r.structural.filter((s) => s.kind === "consistency-check");
    expect(consistency.length).toBeGreaterThan(0);
  });

  it("covers L1a canvas/webgl/audio fingerprint surfaces in findings", () => {
    const cats = new Set(r.findings.map((f) => f.api.category));
    expect(cats.has("canvas")).toBe(true);
    expect(cats.has("webgl")).toBe(true);
    expect(cats.has("audio")).toBe(true);
  });

  it("leakedApiCount picks up the exfiltrated fingerprint surfaces", () => {
    expect(r.summary.leakedApiCount).toBeGreaterThan(0);
  });
});

describe("F1 synthetic fixture: Cloudflare Turnstile", () => {
  const src = load("cloudflare-turnstile-synthetic.js");
  const r = analyze(src, { name: "cloudflare-turnstile-synthetic.js" });

  it("parses cleanly", () => {
    expect(r.parse.ok).toBe(true);
  });

  it("classifies as Cloudflare via the provider table", () => {
    expect(r.summary.providers).toHaveProperty("Cloudflare Turnstile");
  });

  it("renders a non-null verdict line", () => {
    const text = renderText(r, { noColor: true, showHits: false });
    expect(text).toMatch(/verdict/);
  });

  it("captures the behavioral-biometrics surface (mousemove handler + isTrusted)", () => {
    const keys = r.findings.map((f) => f.api.key);
    expect(keys).toContain("*.isTrusted");
  });
});
