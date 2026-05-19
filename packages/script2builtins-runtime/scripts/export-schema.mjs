#!/usr/bin/env node
/**
 * Emit a minimal JSON Schema for `RuntimeReport` consumers in
 * non-TypeScript environments. Hand-maintained — keep in sync with
 * `src/types.ts` when adding fields.
 *
 *   node scripts/export-schema.mjs > docs/reportSchema.json
 */
const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://StackedQueries.github.io/script2builtins-runtime/reportSchema.json",
  title: "RuntimeReport",
  type: "object",
  required: [
    "reportVersion", "catalogVersion", "trapScriptSha256",
    "target", "runId", "startedAt", "endedAt", "harnessMode",
    "events", "scripts", "reconstructedAccesses", "reconstructedSinks",
    "hazards", "findings", "byCategory", "summary",
  ],
  properties: {
    reportVersion: { const: "1.0.0" },
    catalogVersion: { type: "string", pattern: "^script2builtins@" },
    trapScriptSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    target: { type: "string" },
    runId: { type: "string" },
    startedAt: { type: "string", format: "date-time" },
    endedAt: { type: "string", format: "date-time" },
    navError: { type: ["string", "null"] },
    harnessMode: { enum: ["url", "data", "file", "http-harness"] },
    events: { type: "array", items: { $ref: "#/$defs/runtimeEvent" } },
    scripts: { type: "array", items: { $ref: "#/$defs/scriptAnalysis" } },
    reconstructedAccesses: { type: "array" },
    reconstructedSinks: { type: "array" },
    hazards: { type: "array" },
    findings: { type: "array", items: { $ref: "#/$defs/annotatedFinding" } },
    byCategory: { type: "object" },
    summary: { $ref: "#/$defs/summary" },
  },
  $defs: {
    runtimeEvent: {
      oneOf: [
        { $ref: "#/$defs/accessEvent" },
        { $ref: "#/$defs/sinkEvent" },
        { $ref: "#/$defs/hazardEvent" },
      ],
    },
    accessEvent: {
      type: "object",
      required: ["kind", "seq", "t", "chain", "called", "via"],
      properties: {
        kind: { const: "access" },
        seq: { type: "integer" },
        t: { type: "number" },
        scriptUrl: { type: ["string", "null"] },
        scriptSha256: { type: ["string", "null"] },
        chain: { type: "array", items: { type: "string" } },
        called: { type: "boolean" },
        firstStringArg: { type: ["string", "null"] },
        via: { enum: ["proxy", "descriptor", "reflect", "apply"] },
      },
    },
    sinkEvent: {
      type: "object",
      required: ["kind", "sinkKind", "url"],
      properties: {
        kind: { const: "sink" },
        sinkKind: {
          enum: [
            "fetch", "xhr", "sendBeacon",
            "websocket-open", "websocket-send",
            "eventsource", "image-src", "script-src",
            "worker", "shared-worker", "service-worker",
            "importScripts", "navigation",
          ],
        },
        url: { type: "string" },
        method: { type: ["string", "null"] },
        headers: { type: "object" },
        body: {
          oneOf: [
            { type: "null" },
            {
              type: "object",
              required: ["shape", "preview", "truncated"],
              properties: {
                shape: { enum: ["string", "json", "formdata", "urlsearchparams", "blob", "binary", "empty"] },
                preview: { type: "string" },
                truncated: { type: "boolean" },
              },
            },
          ],
        },
      },
    },
    hazardEvent: {
      type: "object",
      required: ["kind", "hazardKind", "source", "sha256"],
      properties: {
        kind: { const: "hazard" },
        hazardKind: {
          enum: ["eval", "Function", "setTimeout-string", "setInterval-string", "import-call", "document-write"],
        },
        source: { type: "string" },
        truncated: { type: "boolean" },
        sha256: { type: "string" },
      },
    },
    scriptAnalysis: {
      type: "object",
      required: ["name", "sha256", "bytes", "acquisition"],
      properties: {
        name: { type: "string" },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        bytes: { type: "integer" },
        acquisition: { enum: ["network", "inline", "eval", "function-ctor", "settimeout-string"] },
        frames: { type: "array", items: { type: "string" } },
        eventRange: { type: "array", items: { type: ["integer", "null"] }, minItems: 2, maxItems: 2 },
        trapCoverage: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    annotatedFinding: {
      type: "object",
      required: ["api", "count", "provenance", "callSites"],
      properties: {
        provenance: { enum: ["static", "runtime", "static+runtime"] },
        count: { type: "integer" },
        callSites: { type: "integer" },
        sampleStacks: { type: "array", items: { type: "string" } },
      },
    },
    summary: {
      type: "object",
      required: [
        "totalScripts", "totalAccesses", "knownAccesses",
        "botDetectionTells", "sinkCount", "leakedApiCount",
        "preExistingPages", "bufferOverflows",
      ],
    },
  },
};

process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
