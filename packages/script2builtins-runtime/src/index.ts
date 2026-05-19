/**
 * Single library entry. A user importing from "script2builtins-runtime"
 * gets the static analyzer, the runtime driver, and a small URL helper
 * — all without needing to know which underlying package owns which.
 *
 * The static analyzer is re-exported from "script2builtins" so callers
 * can write one import and reach for whichever mode their input shape
 * suggests.
 */

// ─── Static analyzer surface (re-exported from script2builtins) ─────────────
export { analyze, renderText, ALL_APIS } from "script2builtins";
export type {
  Report,
  RawAccess,
  NetworkSink,
  Finding,
  ApiDefinition,
  AnalyzeOptions,
} from "script2builtins/types";

// ─── Runtime surface ────────────────────────────────────────────────────────
export { attach, run, runFromUrl } from "./runner/driver.js";
export { runHarness, buildHarnessHtml } from "./runner/harness.js";
export type { RunHarnessOptions } from "./runner/harness.js";
export { analyzeUrl } from "./runner/analyze-url.js";
export { buildTrapScript, WATCHED_PROTOTYPES } from "./trap/build.js";
export type { BuiltTrapScript, TrapBuildOptions } from "./trap/build.js";
export { buildStealthScript } from "./runner/stealth.js";
export type { BuiltStealthScript, StealthOptions } from "./runner/stealth.js";
export { renderRuntimeText } from "./report/text.js";
export type { RenderRuntimeOptions } from "./report/text.js";
export { renderHtmlIndex } from "./report/html.js";
export type { HtmlIndexOptions } from "./report/html.js";
export { catalogVersion } from "./catalog-version.js";
export {
  drainContext,
  drainPage,
  parseStack,
  toRawAccesses,
  toNetworkSinks,
  toDynamicHazards,
} from "./runner/collect.js";
export { mergeFindings, runtimeOnlyKeys, staticOnlyKeys } from "./runner/merge.js";
export { diffReports, renderDiffText } from "./runner/diff.js";
export type { ReportDiff, RenderDiffOptions } from "./runner/diff.js";

export { REPORT_VERSION } from "./types.js";
export type {
  AnnotatedFinding,
  AnyRuntimeEvent,
  AttachOptions,
  Provenance,
  RunOptions,
  RuntimeAccessEvent,
  RuntimeEventBase,
  RuntimeHazardEvent,
  RuntimeReport,
  RuntimeSinkBody,
  RuntimeSinkEvent,
  ScriptAcquisition,
  ScriptAnalysis,
  Session,
} from "./types.js";
