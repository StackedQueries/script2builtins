/**
 * Sub-package entry point for the analyzer internals. Use this when
 * you want to compose pieces of the pipeline yourself (e.g., feed in
 * your own AST, swap the API catalog, or reuse the alias/value
 * resolvers in a different tool).
 *
 * Example:
 *
 * ```ts
 * import { parse, walkProgram, matchAccesses, scanSinks } from "script2builtins/analyze";
 * import { ALL_APIS, watchedRoots } from "script2builtins-knowledge";
 *
 * const { program } = parse(source);
 * const { accesses, hazards, aliases } = walkProgram(program!, {
 *   source,
 *   watchedRoots: watchedRoots(ALL_APIS),
 *   snippetLength: 120,
 * });
 * const { findings, unknown } = matchAccesses(accesses, ALL_APIS);
 * const sinks = scanSinks(program!, aliases, { source, apis: ALL_APIS });
 * ```
 */

export { parse } from "./parse.js";
export type { ParseResult } from "./parse.js";
export { walkProgram } from "./walk.js";
export type { WalkResult } from "./walk.js";
export { matchAccesses } from "./match.js";
export { scanSinks, tracePayload, parseRuntimeBody } from "./sinks.js";
export type { SinkScanOptions, RuntimeBody } from "./sinks.js";
export { detectVmBytecode } from "./vm-detector.js";
export { detectConsistencyChecks, detectHighResTimer } from "./structural.js";
export { detectCognitiveHoneypots } from "./honeypots.js";
export { detectFaviconCacheProbes } from "./favicons.js";
export {
  buildAliases,
  resolveChain,
  resolveProperty,
  resolveStaticString,
  type AliasMap,
} from "./aliases.js";
export {
  buildValues,
  classifyValue,
  type ValueMap,
  type ValueOrigin,
  type ValueEntry,
} from "./values.js";
