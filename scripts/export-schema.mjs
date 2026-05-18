#!/usr/bin/env node
/**
 * Emit a JSON Schema for the analyzer Report type.
 *
 * The schema is hand-written here (rather than auto-derived from the
 * TS types) so the project stays deps-free for consumers. When you
 * change the `Report` shape in `src/types.ts`, mirror the change in
 * this file and re-run `npm run export-schema`.
 *
 * The script writes `schemas/report.schema.json` from the repo root.
 * Consumers can `$ref` that file (it's included in the published
 * package via the `files` array) to validate analyzer output.
 *
 * Spec: JSON Schema draft 2020-12.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/yourorg/script2builtins/schemas/report.schema.json",
  title: "script2builtins Report",
  description:
    "JSON-serialized output of `analyze()`. See `src/types.ts` for the corresponding TypeScript types — this schema mirrors the `Report` interface and is the contract for any tool consuming s2b output.",
  type: "object",
  required: [
    "source",
    "parse",
    "findings",
    "byCategory",
    "hazards",
    "networkSinks",
    "structural",
    "unknownAccesses",
    "summary",
  ],
  properties: {
    source: { $ref: "#/$defs/Source" },
    parse: { $ref: "#/$defs/ParseInfo" },
    findings: { type: "array", items: { $ref: "#/$defs/Finding" } },
    byCategory: {
      type: "object",
      additionalProperties: { type: "array", items: { $ref: "#/$defs/Finding" } },
    },
    hazards: { type: "array", items: { $ref: "#/$defs/DynamicHazard" } },
    networkSinks: { type: "array", items: { $ref: "#/$defs/NetworkSink" } },
    structural: { type: "array", items: { $ref: "#/$defs/StructuralFinding" } },
    unknownAccesses: { type: "array", items: { $ref: "#/$defs/RawAccess" } },
    summary: { $ref: "#/$defs/Summary" },
  },
  $defs: {
    Severity: { type: "string", enum: ["info", "low", "medium", "high"] },
    SokLayer: { type: "string", enum: ["L1a", "L1b", "L2", "L3", "L4"] },
    Source: {
      type: "object",
      required: ["name", "bytes", "lines"],
      properties: {
        name: { type: "string" },
        bytes: { type: "integer", minimum: 0 },
        lines: { type: "integer", minimum: 0 },
      },
    },
    ParseInfo: {
      type: "object",
      required: ["ok", "sourceType", "errors"],
      properties: {
        ok: { type: "boolean" },
        sourceType: { type: "string", enum: ["script", "module"] },
        errors: { type: "array", items: { type: "string" } },
      },
    },
    Location: {
      type: "object",
      required: ["start", "end"],
      properties: {
        start: {
          type: "object",
          required: ["line", "column"],
          properties: {
            line: { type: "integer", minimum: 0 },
            column: { type: "integer", minimum: 0 },
          },
        },
        end: {
          type: "object",
          required: ["line", "column"],
          properties: {
            line: { type: "integer", minimum: 0 },
            column: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    RawAccess: {
      type: "object",
      required: [
        "chain",
        "called",
        "loc",
        "snippet",
        "resolvedThroughObfuscation",
        "hasDynamicSegment",
      ],
      properties: {
        chain: { type: "array", items: { type: ["string", "null"] } },
        called: { type: "boolean" },
        loc: { anyOf: [{ $ref: "#/$defs/Location" }, { type: "null" }] },
        snippet: { type: "string" },
        resolvedThroughObfuscation: { type: "boolean" },
        hasDynamicSegment: { type: "boolean" },
        firstStringArg: { type: ["string", "null"] },
      },
    },
    ApiDefinition: {
      type: "object",
      required: ["key", "category", "description", "severity"],
      properties: {
        key: { type: "string" },
        category: { type: "string" },
        description: { type: "string" },
        severity: { $ref: "#/$defs/Severity" },
        botDetectionTell: { type: "boolean" },
        evasion: { type: "string" },
        argMatch: { type: "array", items: { type: "string" } },
        layer: { $ref: "#/$defs/SokLayer" },
      },
    },
    Finding: {
      type: "object",
      required: ["api", "hits", "count"],
      properties: {
        api: { $ref: "#/$defs/ApiDefinition" },
        hits: { type: "array", items: { $ref: "#/$defs/RawAccess" } },
        count: { type: "integer", minimum: 0 },
      },
    },
    DynamicHazardKind: {
      type: "string",
      enum: [
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
      ],
    },
    DynamicHazard: {
      type: "object",
      required: ["kind", "loc", "snippet", "detail"],
      properties: {
        kind: { $ref: "#/$defs/DynamicHazardKind" },
        loc: { anyOf: [{ $ref: "#/$defs/Location" }, { type: "null" }] },
        snippet: { type: "string" },
        detail: { type: "string" },
      },
    },
    StructuralFindingKind: {
      type: "string",
      enum: [
        "vm-bytecode",
        "consistency-check",
        "cognitive-honeypot",
        "high-res-timer-construction",
        "favicon-cache-probe",
      ],
    },
    StructuralFinding: {
      type: "object",
      required: ["kind", "subkind", "severity", "description", "details", "loc", "snippet"],
      properties: {
        kind: { $ref: "#/$defs/StructuralFindingKind" },
        subkind: { type: "string" },
        severity: { $ref: "#/$defs/Severity" },
        description: { type: "string" },
        details: { type: "object", additionalProperties: true },
        loc: { anyOf: [{ $ref: "#/$defs/Location" }, { type: "null" }] },
        snippet: { type: "string" },
      },
    },
    NetworkSinkKind: {
      type: "string",
      enum: [
        "fetch",
        "xhr",
        "sendBeacon",
        "websocket-open",
        "websocket-send",
        "eventsource",
        "image-src",
        "script-src",
        "worker",
        "shared-worker",
        "service-worker",
        "importScripts",
        "navigation",
      ],
    },
    PayloadInfoShape: {
      type: "string",
      enum: [
        "json",
        "object",
        "string",
        "formdata",
        "urlsearchparams",
        "blob",
        "url-query",
        "unknown",
      ],
    },
    PayloadEntry: {
      type: "object",
      required: ["key", "sourceChain", "snippet"],
      properties: {
        key: { type: "string" },
        sourceChain: {
          anyOf: [
            { type: "array", items: { type: ["string", "null"] } },
            { type: "null" },
          ],
        },
        leakedApi: { $ref: "#/$defs/ApiDefinition" },
        literalValue: { type: ["string", "number", "boolean", "null"] },
        snippet: { type: "string" },
      },
    },
    PayloadInfo: {
      type: "object",
      required: ["shape", "entries", "leakedApis", "snippet"],
      properties: {
        shape: { $ref: "#/$defs/PayloadInfoShape" },
        entries: { type: "array", items: { $ref: "#/$defs/PayloadEntry" } },
        leakedApis: { type: "array", items: { $ref: "#/$defs/ApiDefinition" } },
        snippet: { type: "string" },
      },
    },
    NetworkSink: {
      type: "object",
      required: ["kind", "url", "method", "headers", "loc", "snippet", "payload"],
      properties: {
        kind: { $ref: "#/$defs/NetworkSinkKind" },
        url: { type: ["string", "null"] },
        urlSnippet: { type: "string" },
        method: { type: ["string", "null"] },
        headers: {
          type: "object",
          additionalProperties: { type: ["string", "null"] },
        },
        loc: { anyOf: [{ $ref: "#/$defs/Location" }, { type: "null" }] },
        snippet: { type: "string" },
        payload: { anyOf: [{ $ref: "#/$defs/PayloadInfo" }, { type: "null" }] },
        provider: { type: ["string", "null"] },
      },
    },
    Summary: {
      type: "object",
      required: [
        "totalAccesses",
        "knownAccesses",
        "botDetectionTells",
        "fingerprintingDensityPerKb",
        "categories",
        "sinkCount",
        "leakedApiCount",
        "providers",
        "vmBytecodeDetected",
        "antiDebugTells",
        "consistencyChecks",
      ],
      properties: {
        totalAccesses: { type: "integer", minimum: 0 },
        knownAccesses: { type: "integer", minimum: 0 },
        botDetectionTells: { type: "integer", minimum: 0 },
        fingerprintingDensityPerKb: { type: "number", minimum: 0 },
        categories: { type: "array", items: { type: "string" } },
        sinkCount: { type: "integer", minimum: 0 },
        leakedApiCount: { type: "integer", minimum: 0 },
        providers: {
          type: "object",
          additionalProperties: { type: "integer", minimum: 0 },
        },
        vmBytecodeDetected: { type: "boolean" },
        antiDebugTells: { type: "integer", minimum: 0 },
        consistencyChecks: { type: "integer", minimum: 0 },
      },
    },
  },
};

const outDir = resolve(repoRoot, "schemas");
const outPath = resolve(outDir, "report.schema.json");
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf8");

console.log(`wrote ${outPath} (${JSON.stringify(schema).length} bytes)`);
