/**
 * script2builtins — forensic static analyzer for fingerprinting JS.
 *
 * Public entry point. Most consumers want {@link analyze} and
 * {@link renderText}; advanced consumers can reach into {@link parse},
 * {@link walkProgram}, {@link scanSinks}, {@link matchAccesses}, and
 * the {@link ALL_APIS} catalog.
 */

import type { AnalyzeOptions, Report, Finding, NetworkSink } from "./types.js";
import { parse } from "./analyze/parse.js";
import { walkProgram } from "./analyze/walk.js";
import { matchAccesses } from "./analyze/match.js";
import { scanSinks } from "./analyze/sinks.js";
import { ALL_APIS, watchedRoots } from "./knowledge/index.js";

// ─── Public types ────────────────────────────────────────────────────────────
export type {
  AnalyzeOptions,
  Report,
  Finding,
  RawAccess,
  ApiDefinition,
  DynamicHazard,
  DynamicHazardKind,
  Severity,
  ParseInfo,
  Location,
  NetworkSink,
  NetworkSinkKind,
  PayloadInfo,
  PayloadEntry,
} from "./types.js";

// ─── Public modules ──────────────────────────────────────────────────────────
export { ALL_APIS, watchedRoots } from "./knowledge/index.js";
export {
  navigatorApis,
  windowScreenApis,
  documentApis,
  canvasApis,
  webglApis,
  audioApis,
  webrtcApis,
  timingApis,
  headlessTellApis,
  introspectionApis,
  storageFontsApis,
  sensorApis,
  mediaPermissionsApis,
  eventsDomApis,
} from "./knowledge/index.js";

export { parse } from "./analyze/parse.js";
export type { ParseResult } from "./analyze/parse.js";
export { walkProgram } from "./analyze/walk.js";
export type { WalkResult } from "./analyze/walk.js";
export { matchAccesses } from "./analyze/match.js";
export { scanSinks } from "./analyze/sinks.js";
export {
  buildAliases,
  resolveChain,
  resolveProperty,
  resolveStaticString,
  type AliasMap,
} from "./analyze/aliases.js";
export {
  buildValues,
  classifyValue,
  type ValueMap,
  type ValueOrigin,
  type ValueEntry,
} from "./analyze/values.js";
export { renderText } from "./report/text.js";
export type { RenderTextOptions } from "./report/text.js";

const DEFAULT_SNIPPET = 120;

/**
 * Analyze a JS source string. Single entry point that runs:
 *   1. Parse (acorn, module-then-script fallback).
 *   2. Walk for property accesses, identifier references, and dynamic
 *      hazards (eval, Function, with, …).
 *   3. Match accesses against the cataloged fingerprinting APIs.
 *   4. Scan for network sinks (fetch / XHR / sendBeacon / WebSocket /
 *      Image-src / etc.) and statically trace each body to figure out
 *      which fingerprint surfaces are exfiltrated.
 *
 * The returned {@link Report} is JSON-serializable.
 */
export function analyze(source: string, options: AnalyzeOptions = {}): Report {
  const name = options.name ?? "<input>";
  const snippetLength = options.snippetLength ?? DEFAULT_SNIPPET;
  const lines = countLines(source);
  const bytes = Buffer.byteLength(source, "utf8");

  const { program, info } = parse(source, options.sourceType);

  if (!program) {
    return {
      source: { name, bytes, lines },
      parse: info,
      findings: [],
      byCategory: {},
      hazards: [],
      networkSinks: [],
      unknownAccesses: [],
      summary: emptySummary(),
    };
  }

  const { accesses, hazards, aliases } = walkProgram(program, {
    source,
    watchedRoots: watchedRoots(ALL_APIS),
    snippetLength,
  });

  const { findings, unknown } = matchAccesses(accesses, ALL_APIS);
  const networkSinks = scanSinks(program, aliases, { source, apis: ALL_APIS });

  const byCategory = groupByCategory(findings);
  const summary = computeSummary({ findings, networkSinks, bytes });

  return {
    source: { name, bytes, lines },
    parse: info,
    findings,
    byCategory,
    hazards,
    networkSinks,
    unknownAccesses: options.includeUnknown ? unknown : [],
    summary,
  };
}

function groupByCategory(findings: Finding[]): Record<string, Finding[]> {
  const out: Record<string, Finding[]> = {};
  for (const f of findings) (out[f.api.category] ??= []).push(f);
  return out;
}

function computeSummary(args: {
  findings: Finding[];
  networkSinks: NetworkSink[];
  bytes: number;
}) {
  const { findings, networkSinks, bytes } = args;
  let totalAccesses = 0;
  let knownAccesses = 0;
  let botDetectionTells = 0;
  const cats = new Set<string>();
  for (const f of findings) {
    knownAccesses += f.count;
    totalAccesses += f.count;
    cats.add(f.api.category);
    if (f.api.botDetectionTell) botDetectionTells += f.count;
  }
  const leaked = new Set<string>();
  for (const s of networkSinks) {
    for (const a of s.payload?.leakedApis ?? []) leaked.add(a.key);
  }
  const kb = bytes / 1024;
  const fingerprintingDensityPerKb = kb > 0 ? +(knownAccesses / kb).toFixed(2) : 0;
  return {
    totalAccesses,
    knownAccesses,
    botDetectionTells,
    fingerprintingDensityPerKb,
    categories: [...cats].sort(),
    sinkCount: networkSinks.length,
    leakedApiCount: leaked.size,
  };
}

function emptySummary() {
  return {
    totalAccesses: 0,
    knownAccesses: 0,
    botDetectionTells: 0,
    fingerprintingDensityPerKb: 0,
    categories: [] as string[],
    sinkCount: 0,
    leakedApiCount: 0,
  };
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

