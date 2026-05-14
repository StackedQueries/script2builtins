import { describe, expect, it } from "vitest";
import { parseRuntimeBody } from "../src/analyze/sinks.js";
import { ALL_APIS } from "../src/knowledge/index.js";

function keys(p: ReturnType<typeof parseRuntimeBody>): string[] {
  return p.entries.map((e) => e.key);
}
function leaked(p: ReturnType<typeof parseRuntimeBody>): string[] {
  return p.leakedApis.map((a) => a.key).sort();
}

describe("parseRuntimeBody", () => {
  it("extracts JSON object keys and matches fingerprint APIs", () => {
    const body = {
      shape: "json" as const,
      preview: JSON.stringify({
        userAgent: "Mozilla/5.0…",
        platform: "MacIntel",
        languages: ["en"],
        hardwareConcurrency: 8,
        unrelatedKey: 1,
      }),
      truncated: false,
    };
    const p = parseRuntimeBody(body, ALL_APIS);
    expect(p.shape).toBe("json");
    expect(keys(p)).toEqual(
      expect.arrayContaining(["userAgent", "platform", "languages", "hardwareConcurrency"]),
    );
    expect(leaked(p)).toEqual(
      expect.arrayContaining([
        "navigator.userAgent",
        "navigator.platform",
        "navigator.languages",
        "navigator.hardwareConcurrency",
      ]),
    );
  });

  it("auto-detects JSON inside a string body", () => {
    const body = {
      shape: "string" as const,
      preview: `{"userAgent":"x","webdriver":true}`,
      truncated: false,
    };
    const p = parseRuntimeBody(body, ALL_APIS);
    expect(p.shape).toBe("json");
    expect(leaked(p)).toContain("navigator.webdriver");
  });

  it("parses urlencoded url-form bodies", () => {
    const body = {
      shape: "urlsearchparams" as const,
      preview: "userAgent=foo&deviceMemory=8&junk=1",
      truncated: false,
    };
    const p = parseRuntimeBody(body, ALL_APIS);
    expect(p.shape).toBe("urlsearchparams");
    expect(keys(p)).toEqual(["userAgent", "deviceMemory", "junk"]);
    expect(leaked(p)).toEqual(
      expect.arrayContaining(["navigator.userAgent", "navigator.deviceMemory"]),
    );
  });

  it("falls back to urlencoded when a string body looks like a=1&b=2", () => {
    const body = {
      shape: "string" as const,
      preview: "userAgent=x&platform=MacIntel",
      truncated: false,
    };
    const p = parseRuntimeBody(body, ALL_APIS);
    expect(p.shape).toBe("urlsearchparams");
    expect(leaked(p)).toEqual(
      expect.arrayContaining(["navigator.userAgent", "navigator.platform"]),
    );
  });

  it("decodes formdata pair-array previews emitted by the trap", () => {
    const body = {
      shape: "formdata" as const,
      preview: JSON.stringify([
        ["userAgent", "x"],
        ["languages", "en"],
      ]),
      truncated: false,
    };
    const p = parseRuntimeBody(body, ALL_APIS);
    expect(p.shape).toBe("formdata");
    expect(leaked(p)).toEqual(
      expect.arrayContaining(["navigator.userAgent", "navigator.languages"]),
    );
  });

  it("returns no entries for opaque shapes", () => {
    const blob = parseRuntimeBody(
      { shape: "blob", preview: "[Blob size=512 type=]", truncated: false },
      ALL_APIS,
    );
    expect(blob.entries).toEqual([]);
    expect(blob.leakedApis).toEqual([]);

    const binary = parseRuntimeBody({ shape: "binary", preview: "deadbeef", truncated: false }, ALL_APIS);
    expect(binary.entries).toEqual([]);

    const empty = parseRuntimeBody({ shape: "empty", preview: "", truncated: false }, ALL_APIS);
    expect(empty.entries).toEqual([]);
  });

  it("flattens nested fingerprint payloads up to 3 levels", () => {
    const body = {
      shape: "json" as const,
      preview: JSON.stringify({
        nav: { userAgent: "x", deep: { platform: "MacIntel" } },
        screen: { width: 1920 },
      }),
      truncated: false,
    };
    const p = parseRuntimeBody(body, ALL_APIS);
    expect(keys(p)).toEqual(
      expect.arrayContaining(["nav.userAgent", "nav.deep.platform", "screen.width"]),
    );
    expect(leaked(p)).toEqual(
      expect.arrayContaining(["navigator.userAgent", "navigator.platform", "screen.width"]),
    );
  });

  it("survives malformed JSON without throwing", () => {
    const body = {
      shape: "json" as const,
      preview: "{not really json",
      truncated: false,
    };
    const p = parseRuntimeBody(body, ALL_APIS);
    expect(p.shape).toBe("string");
    expect(p.entries[0]?.key).toBe("<body>");
  });

  it("survives malformed urlencoded escapes without throwing", () => {
    const body = {
      shape: "urlsearchparams" as const,
      preview: "userAgent=%FFinvalid&platform=x",
      truncated: false,
    };
    const p = parseRuntimeBody(body, ALL_APIS);
    expect(keys(p)).toContain("userAgent");
    expect(leaked(p)).toContain("navigator.platform");
  });
});
