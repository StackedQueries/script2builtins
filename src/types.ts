/**
 * Severity tiers used across the catalog.
 *
 * - `info`   ubiquitous APIs that show up in plenty of legitimate code.
 * - `low`    fingerprint-relevant but low entropy or expected.
 * - `medium` strong fingerprint signals (canvas/audio/WebGL surfaces).
 * - `high`   bot-specific tells or high-leakage operations.
 */
export type Severity = "info" | "low" | "medium" | "high";

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

/**
 * One entry in the fingerprinting-API catalog. Catalog files in
 * `src/knowledge/` export arrays of these.
 */
export interface ApiDefinition {
  /**
   * Match key. Two forms:
   *   - `"navigator.userAgent"` — chain (after global-root stripping) starts with this.
   *   - `"*.toDataURL"` — chain ends with this suffix, root is irrelevant.
   */
  key: string;
  /** Logical category (used for grouping in reports). */
  category: string;
  /** Short human description of what the API leaks or signals. */
  description: string;
  severity: Severity;
  /** Set when this access is a strong indicator of bot detection. */
  botDetectionTell?: boolean;
  /** Notes on common evasion strategies for users reverse-engineering. */
  evasion?: string;
  /**
   * When set, an access only matches if its `firstStringArg` equals one
   * of these strings. Used to split polymorphic methods such as
   * `getContext("2d")` vs `getContext("webgl")`.
   */
  argMatch?: string[];
}

/** A cataloged API plus the raw accesses that satisfied it. */
export interface Finding {
  api: ApiDefinition;
  hits: RawAccess[];
  count: number;
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
  | "import-call";

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
 */
export type NetworkSinkKind =
  | "fetch"
  | "xhr"
  | "sendBeacon"
  | "websocket-open"
  | "websocket-send"
  | "eventsource"
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
