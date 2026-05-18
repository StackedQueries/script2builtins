/**
 * Real captured detector blobs (IMPROVEMENTS.md F1, completion).
 *
 * Where `test/fixtures.test.ts` runs synthetic mocks that can only
 * exercise the patterns we already know to detect, this suite points
 * the analyzer at real bot-detection scripts fetched from public
 * endpoints and asserts that:
 *
 *   - they still parse cleanly,
 *   - the cataloged surface area lights up at a credible volume,
 *   - the vendor-specific structural / behavioral fingerprints we
 *     expect (cognitive-honeypot for CF, behavioral biometrics for
 *     DataDome, eval-driven WAF logic for reCAPTCHA) are visible.
 *
 * Floors are deliberately loose — vendor scripts churn, and tying
 * tests to exact counts would just guarantee a green-to-red flip on
 * every refresh. The floors below are roughly half of the
 * fetched-blob counts captured at check-in, which is the band where a
 * regression would mean real coverage loss.
 *
 * Gated on `S2B_RUN_E2E=1` so the default `npm test` stays fast — the
 * reCAPTCHA fixture alone is ~860 KB and the full suite walks every
 * statement. See `test/fixtures/captured/README.md` for the
 * collection / anonymization recipe and the legal stance.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyze, renderText } from "../src/index.js";

const fixturesDir = resolve(__dirname, "fixtures", "captured");
const RUN = process.env.S2B_RUN_E2E === "1";

function load(name: string): string {
  return readFileSync(resolve(fixturesDir, name), "utf8");
}

function present(name: string): boolean {
  return existsSync(resolve(fixturesDir, name));
}

const describeOrSkip = RUN ? describe : describe.skip;

describeOrSkip("F1 captured fixture: Cloudflare Turnstile", () => {
  if (!present("cloudflare-turnstile.js")) {
    it.skip("fixture missing — run `node scripts/fetch-fixtures.mjs`", () => {});
    return;
  }
  const src = load("cloudflare-turnstile.js");
  const r = analyze(src, { name: "cloudflare-turnstile.js" });

  it("parses cleanly", () => {
    expect(r.parse.ok).toBe(true);
    expect(r.parse.errors).toEqual([]);
  });

  it("hits a credible bot-detection-tell floor (CF Turnstile is L2-heavy)", () => {
    expect(r.summary.botDetectionTells).toBeGreaterThanOrEqual(15);
  });

  it("emits at least one network sink (Turnstile reports back to the challenge platform)", () => {
    expect(r.summary.sinkCount).toBeGreaterThanOrEqual(2);
  });

  it("detects the cognitive-honeypot structural pattern", () => {
    const kinds = new Set(r.structural.map((s) => s.kind));
    expect(kinds.has("cognitive-honeypot")).toBe(true);
  });

  it("flags the Function.toString stealth-bypass trampoline", () => {
    const keys = new Set(r.findings.map((f) => f.api.key));
    expect(keys.has("Function.toString")).toBe(true);
  });

  it("covers cross-realm probes via *.contentWindow", () => {
    const keys = new Set(r.findings.map((f) => f.api.key));
    expect(keys.has("*.contentWindow")).toBe(true);
  });

  it("covers behavioral biometrics via *.isTrusted", () => {
    const keys = new Set(r.findings.map((f) => f.api.key));
    expect(keys.has("*.isTrusted")).toBe(true);
  });

  it("renders without throwing and contains the summary block", () => {
    const text = renderText(r, { noColor: true, showHits: false });
    expect(text).toMatch(/summary/);
    // The verdict line is opportunistic — `classifyScript` returns
    // null when sinks have dynamic URLs (the common case for real CF
    // blobs, whose endpoint is constructed at runtime). Don't assert
    // on it.
    expect(text.length).toBeGreaterThan(200);
  });
});

describeOrSkip("F1 captured fixture: DataDome", () => {
  if (!present("datadome.js")) {
    it.skip("fixture missing — run `node scripts/fetch-fixtures.mjs`", () => {});
    return;
  }
  const src = load("datadome.js");
  const r = analyze(src, { name: "datadome.js" });

  it("parses cleanly", () => {
    expect(r.parse.ok).toBe(true);
    expect(r.parse.errors).toEqual([]);
  });

  it("hits a credible bot-detection-tell floor", () => {
    expect(r.summary.botDetectionTells).toBeGreaterThanOrEqual(5);
  });

  it("emits at least one network sink (telemetry POST + escalation probe)", () => {
    expect(r.summary.sinkCount).toBeGreaterThanOrEqual(2);
  });

  it("touches the L1b behavioral-biometrics surface (events) and the WebRTC IP probe", () => {
    const cats = new Set(r.summary.categories);
    expect(cats.has("events")).toBe(true);
    expect(cats.has("webrtc")).toBe(true);
  });

  it("touches the fingerprinting categories DataDome is known for (math + fonts + workers)", () => {
    const cats = new Set(r.summary.categories);
    expect(cats.has("math")).toBe(true);
    expect(cats.has("fonts")).toBe(true);
    expect(cats.has("workers")).toBe(true);
  });

  it("flags the setTimeout-string eval-equivalent hazard", () => {
    const kinds = new Set(r.hazards.map((h) => h.kind));
    expect(kinds.has("setTimeout-string")).toBe(true);
  });
});

describeOrSkip("F1 captured fixture: Google reCAPTCHA", () => {
  if (!present("google-recaptcha.js")) {
    it.skip("fixture missing — run `node scripts/fetch-fixtures.mjs`", () => {});
    return;
  }
  const src = load("google-recaptcha.js");
  const r = analyze(src, { name: "google-recaptcha.js" });

  it("parses cleanly (~860 KB Closure-Library blob)", () => {
    expect(r.parse.ok).toBe(true);
    expect(r.parse.errors).toEqual([]);
  });

  it("hits a credible bot-detection-tell floor (reCAPTCHA is dense)", () => {
    expect(r.summary.botDetectionTells).toBeGreaterThanOrEqual(25);
  });

  it("emits multiple network sinks (challenge endpoints + telemetry)", () => {
    expect(r.summary.sinkCount).toBeGreaterThanOrEqual(3);
  });

  it("touches the canvas + audio fingerprint surfaces reCAPTCHA is known for", () => {
    const cats = new Set(r.summary.categories);
    expect(cats.has("canvas")).toBe(true);
    expect(cats.has("webrtc")).toBe(true);
  });

  it("flags at least one eval-class dynamic hazard (Closure's Function() use)", () => {
    const kinds = new Set(r.hazards.map((h) => h.kind));
    const hasEvalish =
      kinds.has("eval") ||
      kinds.has("new-Function") ||
      kinds.has("Function-constructor") ||
      kinds.has("obfuscated-eval");
    expect(hasEvalish).toBe(true);
  });

  it("trips the headless-tells category (probes for automation globals)", () => {
    const cats = new Set(r.summary.categories);
    expect(cats.has("headless-tells")).toBe(true);
  });
});
