/**
 * Catalog-shape types (`Severity`, `SokLayer`, `ApiDefinition`) live in
 * `script2builtins-knowledge` so the catalog package can ship without
 * a static-analyzer release. They're re-exported here so existing
 * `import { Severity } from "script2builtins/types"` call sites keep
 * working.
 */
import type {
  Severity,
  SokLayer,
  ApiDefinition,
} from "script2builtins-knowledge";
export type { Severity, SokLayer, ApiDefinition };

/** Source location, mirrors acorn's `loc` shape. */
export interface Location {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

/**
 * A property-access chain extracted from the AST.
 *
 * `chain` is the dot-style path of segments from root to leaf. Segments
 * resolved from a computed access (e.g., `window["navigator"]`) are
 * included as their string value; segments that could not be resolved
 * statically (e.g., `window[varName]`) are recorded as `null`.
 */
export interface RawAccess {
  /** Dot-style path of segments (null for unresolved computed segments). */
  chain: (string | null)[];
  /** True if this chain ends in a CallExpression / NewExpression. */
  called: boolean;
  /** Source location of the outermost expression node. */
  loc: Location | null;
  /** Single-line snippet of the source for display. */
  snippet: string;
  /** True if any segment was resolved through alias chasing or string concat. */
  resolvedThroughObfuscation: boolean;
  /** True if any segment in the chain was unresolvable (computed, dynamic). */
  hasDynamicSegment: boolean;
  /**
   * When `called` is true and the first argument resolves to a string
   * literal, it's recorded here. Lets API definitions disambiguate
   * polymorphic methods like `getContext("2d")` vs `getContext("webgl")`.
   */
  firstStringArg?: string | null;
}

/** A cataloged API plus the raw accesses that satisfied it. */
export interface Finding {
  api: ApiDefinition;
  hits: RawAccess[];
  count: number;
}

/**
 * Multi-node structural signatures the API catalog can't express.
 *
 * - `vm-bytecode`        — script contains a register/stack VM
 *                          (large numeric Array + switch-dispatched function
 *                          table). Canonical for Botguard / Kasada blobs.
 * - `consistency-check`  — script pairs reads of related signals
 *                          (e.g., `navigator.userAgent` and
 *                          `navigator.userAgentData.platform`) — a strong
 *                          signal the script is scoring environment
 *                          consistency, not just collecting features.
 * - `cognitive-honeypot` — script constructs a transparent / off-screen
 *                          DOM element with a click listener attached.
 *                          The defender's anti-VLM-agent trap from
 *                          SoK §3.4 (L3): a real user can't click an
 *                          invisible element, but a vision-based
 *                          agent's "find the button" pass picks the
 *                          decoy out of the layout tree and triggers
 *                          the trap.
 * - `high-res-timer-construction`
 *                        — script reconstructs a sub-µs timer out of
 *                          `SharedArrayBuffer` + `Atomics.wait`/`load`/
 *                          `store` in lieu of (or alongside) the
 *                          mitigated `performance.now`. Canonical L4
 *                          construction from *Fantastic Timers and
 *                          Where to Find Them* (2017) and *JavaScript
 *                          Zero* (2018).
 * - `favicon-cache-probe`
 *                        — script combines a `<link rel="icon">` href
 *                          assignment with an `Image` load-time
 *                          measurement, the canonical favicon-cache
 *                          persistent-tracking trick from *Tales of
 *                          FAVICONS and Caches* (2021).
 */
export interface StructuralFinding {
  kind:
    | "vm-bytecode"
    | "consistency-check"
    | "cognitive-honeypot"
    | "high-res-timer-construction"
    | "favicon-cache-probe";
  /** Short human-readable label (e.g., "UA vs UA-CH platform"). */
  subkind: string;
  severity: Severity;
  description: string;
  /** Structured evidence — what the detector found that triggered the finding. */
  details: Record<string, unknown>;
  loc: Location | null;
  snippet: string;
}

/** Kinds of dynamic-execution hazards we flag separately. */
export type DynamicHazardKind =
  | "eval"
  | "Function"
  | "setTimeout-string"
  | "setInterval-string"
  | "computed-property"
  | "with-statement"
  | "document-write"
  | "import-call"
  | "debugger-statement"
  | "timing-delta-probe"
  | "clock-skew-probe"
  | "cpu-pause-probe"
  | "obfuscated-eval";

/**
 * A spot in the source where the script puts code or content beyond
 * static reach (eval, Function constructor, with-statement, etc.).
 */
export interface DynamicHazard {
  kind: DynamicHazardKind;
  loc: Location | null;
  snippet: string;
  detail: string;
}

/** Result metadata from the parser. */
export interface ParseInfo {
  ok: boolean;
  sourceType: "script" | "module";
  errors: string[];
}

/**
 * Every way a script can ship data off the page. The whole point of a
 * fingerprinting blob is to send the values *somewhere*; this lists
 * those somewheres.
 *
 * `postmessage-send` is a cross-realm sink — the message stays in the
 * browser but crosses an origin boundary (iframe parent/child, popup,
 * MessageChannel port). Common in detector designs that compute the
 * fingerprint in an isolated frame and exfiltrate via the embedder.
 */
export type NetworkSinkKind =
  | "fetch"
  | "xhr"
  | "sendBeacon"
  | "websocket-open"
  | "websocket-send"
  | "eventsource"
  | "postmessage-send"
  | "websocket-message-recv"
  | "eventsource-message-recv"
  | "broadcastchannel-message-recv"
  | "image-src"
  | "script-src"
  | "worker"
  | "shared-worker"
  | "service-worker"
  | "importScripts"
  | "navigation";

/**
 * A discovered network sink. URL, method, headers, and request body
 * are filled in best-effort; values that the script computes
 * dynamically remain null with a `urlSnippet` / `headers[k] = null`
 * marker.
 */
export interface NetworkSink {
  kind: NetworkSinkKind;
  /** Resolved URL string when statically known, else null. */
  url: string | null;
  /** Raw source expression for the URL when not statically resolved. */
  urlSnippet?: string;
  /** HTTP method (uppercased) when known. */
  method: string | null;
  /** Header name → value (value is null when the header value is dynamic). */
  headers: Record<string, string | null>;
  loc: Location | null;
  snippet: string;
  /**
   * Statically-traced body description. Null when the sink has no
   * body (GET requests, EventSource, Worker constructor, etc.).
   */
  payload: PayloadInfo | null;
  /**
   * When the sink's URL or payload field-names match a known anti-bot /
   * captcha / fingerprinting infrastructure provider (see
   * `script2builtins-knowledge` (endpoints classifier)), this is set to the provider slug
   * (e.g. `"Google Botguard"`, `"DataDome"`, `"Cloudflare Turnstile"`).
   * Null when no match.
   */
  provider?: string | null;
  /**
   * SHA-256 of the script that issued this sink, when a captured script
   * could be attributed by stack walk. Runtime-only — the static
   * analyzer always leaves this undefined. Used to answer "which
   * captured script issued this fetch?" by cross-referencing
   * `RuntimeReport.scripts`. Null when the stack didn't resolve to a
   * captured script (synthetic / injected / cross-origin).
   */
  originatingScriptSha256?: string | null;
}

/**
 * What we can statically learn about an exfiltrated request body.
 * Filled in by the payload tracer; describes the *shape* and any
 * fingerprint surfaces that flow into it.
 */
export interface PayloadInfo {
  shape:
    | "json"
    | "object"
    | "string"
    | "formdata"
    | "urlsearchparams"
    | "blob"
    | "url-query"
    | "unknown";
  /** Per-key entries when the payload decomposes into key/value pairs. */
  entries: PayloadEntry[];
  /** Distinct cataloged APIs whose values flow into this payload. */
  leakedApis: ApiDefinition[];
  /** Snippet of the body expression (or the URL with query, for img/script src). */
  snippet: string;
}

/** One key=value entry inside a structured payload. */
export interface PayloadEntry {
  key: string;
  /** Resolved property-access chain that produced this value, when known. */
  sourceChain: (string | null)[] | null;
  /** When `sourceChain` matches a cataloged API, this is set. */
  leakedApi?: ApiDefinition;
  /** When the value is a static literal string/number/bool, recorded here. */
  literalValue?: string | number | boolean | null;
  /** Raw source snippet of the value expression. */
  snippet: string;
}

/**
 * The full output of {@link analyze}. JSON-serializable.
 *
 * - `findings`     — cataloged API uses, sorted by severity
 * - `byCategory`   — same findings grouped by `api.category`
 * - `hazards`      — dynamic-execution sites that escape static reach
 * - `networkSinks` — outbound requests with traced payloads
 * - `summary`      — counts + density + leaked-fingerprint-surface count
 */
export interface Report {
  source: { name: string; bytes: number; lines: number };
  parse: ParseInfo;
  findings: Finding[];
  byCategory: Record<string, Finding[]>;
  hazards: DynamicHazard[];
  /** Network exfiltration sinks discovered in the script. */
  networkSinks: NetworkSink[];
  /**
   * Multi-node structural signatures (VM bytecode dispatch, consistency
   * cross-checks). See {@link StructuralFinding}.
   */
  structural: StructuralFinding[];
  unknownAccesses: RawAccess[];
  summary: {
    totalAccesses: number;
    knownAccesses: number;
    botDetectionTells: number;
    fingerprintingDensityPerKb: number;
    categories: string[];
    /** Number of network sinks discovered. */
    sinkCount: number;
    /** Number of distinct cataloged APIs that flow into any sink payload. */
    leakedApiCount: number;
    /**
     * Known anti-bot / captcha / fingerprinting providers identified
     * across all sinks, mapped to the number of sinks that matched.
     * Empty when no provider patterns hit. See
     * `script2builtins-knowledge` (endpoints classifier) for the full list of recognized
     * providers and matching rules.
     */
    providers: Record<string, number>;
    /**
     * True when the VM-bytecode detector finds the
     * large-numeric-array + switch-dispatched-function-table signature
     * (Botguard / Kasada / Hyperion class).
     */
    vmBytecodeDetected: boolean;
    /**
     * Count of anti-debug-flavored hazards: debugger statements,
     * timing-delta probes, clock-skew probes, CPU-pause probes,
     * obfuscated-eval sites. Effectively the "L3/L4 layer" count from
     * the SoK framework.
     */
    antiDebugTells: number;
    /** Number of consistency-check structural findings. */
    consistencyChecks: number;
  };
}

/** Options for {@link analyze}. */
export interface AnalyzeOptions {
  /** Display name for the source, used in reports. Defaults to `"<input>"`. */
  name?: string;
  /** Force script vs module parse mode. Default: try module then script. */
  sourceType?: "script" | "module";
  /** Include `unknownAccesses` in the report (default false; can be noisy). */
  includeUnknown?: boolean;
  /** Maximum number of source-snippet characters per hit (default 120). */
  snippetLength?: number;
}
