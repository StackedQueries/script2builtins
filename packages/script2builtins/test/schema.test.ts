/**
 * Sanity tests for schemas/report.schema.json. We don't pull in a JSON
 * Schema validator dep just for this — instead we check the shape
 * invariants the schema promises (top-level required keys, the
 * structural-kinds enum matching the TS union, etc.) so drift between
 * `src/types.ts` and `scripts/export-schema.mjs` is caught at test
 * time.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyze } from "../src/index.js";

const schemaPath = resolve(__dirname, "..", "schemas", "report.schema.json");

describe("JSON Schema for Report (G3)", () => {
  it("schema file is committed and readable", () => {
    expect(existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("script2builtins Report");
  });

  it("top-level required keys match the analyze() output shape", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const r = analyze("var x = navigator.userAgent;");
    for (const key of schema.required) {
      expect(r).toHaveProperty(key);
    }
  });

  it("StructuralFindingKind enum covers every kind currently emitted", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const declared: string[] = schema.$defs.StructuralFindingKind.enum;
    // Sentinel: every kind we currently emit in tests/integration must
    // be in the enum. If you add a new structural kind in types.ts,
    // re-run `npm run export-schema` and update both.
    const expected = [
      "vm-bytecode",
      "consistency-check",
      "cognitive-honeypot",
      "high-res-timer-construction",
      "favicon-cache-probe",
    ];
    for (const k of expected) {
      expect(declared).toContain(k);
    }
  });

  it("DynamicHazardKind enum covers the hazards we currently emit", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const declared: string[] = schema.$defs.DynamicHazardKind.enum;
    const expected = [
      "eval",
      "Function",
      "setTimeout-string",
      "setInterval-string",
      "computed-property",
      "with-statement",
      "document-write",
      "import-call",
      "debugger-statement",
      "timing-delta-probe",
      "clock-skew-probe",
      "cpu-pause-probe",
      "obfuscated-eval",
    ];
    for (const k of expected) {
      expect(declared).toContain(k);
    }
  });

  it("Summary required fields include the C7 additions", () => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const required: string[] = schema.$defs.Summary.required;
    for (const k of [
      "vmBytecodeDetected",
      "antiDebugTells",
      "consistencyChecks",
      "providers",
    ]) {
      expect(required).toContain(k);
    }
  });
});
