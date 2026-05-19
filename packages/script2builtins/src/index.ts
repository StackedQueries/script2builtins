/**
 * script2builtins — forensic static analyzer for fingerprinting JS.
 *
 * Public entry point. Most consumers want {@link analyze} and
 * {@link renderText}; advanced consumers can reach into {@link parse},
 * {@link walkProgram}, {@link scanSinks}, {@link matchAccesses}, and
 * the {@link ALL_APIS} catalog.
 */

import type {
  AnalyzeOptions,
  Report,
  Finding,
  NetworkSink,
  StructuralFinding,
  DynamicHazard,
} from "./types.js";
import { parse } from "./analyze/parse.js";
import { walkProgram } from "./analyze/walk.js";
import { matchAccesses } from "./analyze/match.js";
import { scanSinks } from "./analyze/sinks.js";
import { detectVmBytecode } from "./analyze/vm-detector.js";
import { detectConsistencyChecks, detectHighResTimer } from "./analyze/structural.js";
import { detectCognitiveHoneypots } from "./analyze/honeypots.js";
import { detectFaviconCacheProbes } from "./analyze/favicons.js";
import { ALL_APIS, watchedRoots } from "script2builtins-knowledge";

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
  StructuralFinding,
  SokLayer,
} from "./types.js";

// ─── Public modules ──────────────────────────────────────────────────────────
// Catalog re-exported from the standalone knowledge package so existing
// `import { ALL_APIS } from "script2builtins"` consumers keep working.
export { ALL_APIS, watchedRoots } from "script2builtins-knowledge";
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
  consoleApis,
  extensionsApis,
  knownEndpoints,
  classifyEndpointUrl,
  classifyEndpointPayloadKeys,
  type KnownEndpoint,
} from "script2builtins-knowledge";

export { parse } from "./analyze/parse.js";
export type { ParseResult } from "./analyze/parse.js";
export { walkProgram } from "./analyze/walk.js";
export type { WalkResult } from "./analyze/walk.js";
export { matchAccesses } from "./analyze/match.js";
export { scanSinks } from "./analyze/sinks.js";
export { detectVmBytecode } from "./analyze/vm-detector.js";
export { detectConsistencyChecks, detectHighResTimer } from "./analyze/structural.js";
export { detectCognitiveHoneypots } from "./analyze/honeypots.js";
export { detectFaviconCacheProbes } from "./analyze/favicons.js";
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
      structural: [],
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

  const structural: StructuralFinding[] = [];
  const vm = detectVmBytecode(program, source);
  if (vm) structural.push(vm);
  structural.push(...detectConsistencyChecks(findings));
  structural.push(...detectHighResTimer(findings));
  structural.push(...detectCognitiveHoneypots(program, aliases, source));
  structural.push(...detectFaviconCacheProbes(program, aliases, source));

  const byCategory = groupByCategory(findings);
  const summary = computeSummary({ findings, networkSinks, hazards, structural, bytes });

  return {
    source: { name, bytes, lines },
    parse: info,
    findings,
    byCategory,
    hazards,
    networkSinks,
    structural,
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
  hazards: DynamicHazard[];
  structural: StructuralFinding[];
  bytes: number;
}) {
  const { findings, networkSinks, hazards, structural, bytes } = args;
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
  const providers: Record<string, number> = {};
  for (const s of networkSinks) {
    for (const a of s.payload?.leakedApis ?? []) leaked.add(a.key);
    if (s.provider) providers[s.provider] = (providers[s.provider] ?? 0) + 1;
  }
  const ANTI_DEBUG_KINDS = new Set([
    "debugger-statement",
    "timing-delta-probe",
    "clock-skew-probe",
    "cpu-pause-probe",
    "obfuscated-eval",
  ]);
  let antiDebugTells = 0;
  for (const h of hazards) if (ANTI_DEBUG_KINDS.has(h.kind)) antiDebugTells++;
  let vmBytecodeDetected = false;
  let consistencyChecks = 0;
  for (const sf of structural) {
    if (sf.kind === "vm-bytecode") vmBytecodeDetected = true;
    if (sf.kind === "consistency-check") consistencyChecks++;
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
    providers,
    vmBytecodeDetected,
    antiDebugTells,
    consistencyChecks,
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
    providers: {} as Record<string, number>,
    vmBytecodeDetected: false,
    antiDebugTells: 0,
    consistencyChecks: 0,
  };
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

