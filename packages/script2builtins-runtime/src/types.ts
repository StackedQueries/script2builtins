/**
 * Public type surface for script2builtins-runtime.
 *
 * Two design rules drive these shapes:
 *
 * 1. **Same matcher, two event sources.** Runtime events are converted
 *    into RawAccess / NetworkSink (the static analyzer's types) and
 *    matched by the same {@link matchAccesses}. Findings only diverge
 *    in their `provenance` annotation.
 *
 * 2. **Events live once.** The canonical event list is on
 *    {@link RuntimeReport.events}. ScriptAnalysis references its
 *    events by `eventRange: [startSeq, endSeq]` — never copies them.
 */
import type {
  ApiDefinition,
  DynamicHazard,
  Finding,
  Location,
  NetworkSink,
  ParseInfo,
  RawAccess,
  Report,
} from "script2builtins/types";
import type { StealthOptions } from "./runner/stealth.js";

/** Schema version of the {@link RuntimeReport}. Bumps on breaking changes. */
export const REPORT_VERSION = "1.0.0" as const;

/** Provenance tag applied to {@link AnnotatedFinding}. */
export type Provenance = "static" | "runtime" | "static+runtime";

// ─── Event base + concrete kinds ────────────────────────────────────────────

/**
 * Fields every runtime event carries. Has no `kind` discriminator — the
 * concrete event types declare their own so TypeScript can narrow.
 */
export interface RuntimeEventBase {
  /** Monotonic counter assigned in-page. Use as a cursor for incremental drain. */
  seq: number;
  /** `performance.now()` at trap fire. */
  t: number;
  /** Calling script URL parsed from the stack. Null when unparseable. */
  scriptUrl: string | null;
  /**
   * SHA-256 of the calling script's source. Filled in on the Node side
   * by the driver from a url→sha map; null when the URL didn't match a
   * captured script.
   */
  scriptSha256: string | null;
  /** Line number parsed from the stack. */
  line: number | null;
  /** Column parsed from the stack. */
  column: number | null;
  /** Trimmed stack as captured (up to `stackLimit` frames). */
  stack: string;
}

/** Property-access event — direct mapping to {@link RawAccess}. */
export interface RuntimeAccessEvent extends RuntimeEventBase {
  kind: "access";
  /** Concrete chain segments (runtime always sees the resolved keys). */
  chain: string[];
  /** True if the access was a call (apply/construct), false for read. */
  called: boolean;
  /** First string argument when called, else null. */
  firstStringArg: string | null;
  /** How the chain root was observed. */
  via: "proxy" | "descriptor" | "reflect" | "apply";
}

/** Network-sink event — direct mapping to {@link NetworkSink}. */
export interface RuntimeSinkEvent extends RuntimeEventBase {
  kind: "sink";
  sinkKind: NetworkSink["kind"];
  url: string;
  method: string | null;
  headers: Record<string, string>;
  body: RuntimeSinkBody | null;
}

/** Body description recorded by the in-page sink wrappers. */
export interface RuntimeSinkBody {
  shape: "string" | "json" | "formdata" | "urlsearchparams" | "blob" | "binary" | "empty";
  /** Preview text (or hex for binary), truncated to `bodyPreviewLimit`. */
  preview: string;
  truncated: boolean;
}

/** Dynamic-execution event (eval, Function, setTimeout-string, …). */
export interface RuntimeHazardEvent extends RuntimeEventBase {
  kind: "hazard";
  hazardKind:
    | "eval"
    | "Function"
    | "setTimeout-string"
    | "setInterval-string"
    | "import-call"
    | "document-write";
  /** Constructed source — truncated to `evalSourceCap`. */
  source: string;
  truncated: boolean;
  /** SHA-256 of the FULL captured source (computed in-page when feasible, else Node-side). */
  sha256: string;
}

/**
 * SubtleCrypto operation (D8). Emitted when a script calls
 * `crypto.subtle.digest(...)` or `crypto.subtle.sign(...)`. Detectors
 * use these to hash fingerprint blobs before exfiltration; surfacing
 * the algorithm + input prefix lets analysts cross-walk hash values
 * back to the source bytes.
 */
export interface RuntimeCryptoEvent extends RuntimeEventBase {
  kind: "crypto";
  /** Which SubtleCrypto operation fired. */
  op: "digest" | "sign";
  /** Normalized algorithm name (e.g. "SHA-256", "HMAC"). */
  algorithm: string;
  /** Length in bytes of the input that was hashed/signed. */
  inputByteLength: number;
  /**
   * Hex-encoded first 64 bytes of the input (truncated to 128 hex
   * chars). Lets an analyst match the hash output back to the source
   * fingerprint without exfiltrating the full payload.
   */
  inputHexPreview: string;
}

/**
 * WebAssembly module load (D5). Detectors increasingly ship logic in
 * WASM because static analysis tools don't usually reach into the
 * bytecode. Capturing the full bytes (base64-encoded) lets analysts
 * decompile / wasm-objdump the module out-of-band.
 *
 * The driver consumes this event, writes the decoded bytes to disk
 * under `runs/<runId>/wasm/<sha-prefix>.wasm`, and adds a
 * {@link ScriptAnalysis} record with `acquisition: "wasm"` and an
 * empty `staticReport` (the JS analyzer can't parse WASM).
 */
export interface RuntimeWasmEvent extends RuntimeEventBase {
  kind: "wasm";
  op: "compile" | "compileStreaming" | "instantiate" | "instantiateStreaming";
  /** Length in bytes of the captured module. */
  byteLength: number;
  /** Base64-encoded module bytes, truncated to `evalSourceCap`. */
  bytesBase64: string;
  /** True when `bytesBase64` represents only a prefix. */
  truncated: boolean;
  /** SHA-256 of the FULL module bytes (computed in-page). */
  sha256: string;
}

export type AnyRuntimeEvent =
  | RuntimeAccessEvent
  | RuntimeSinkEvent
  | RuntimeHazardEvent
  | RuntimeCryptoEvent
  | RuntimeWasmEvent;

// ─── Per-script bundle ──────────────────────────────────────────────────────

/** How a captured script came to be observed. */
export type ScriptAcquisition =
  | "network"
  | "inline"
  | "srcdoc"
  | "eval"
  | "function-ctor"
  | "settimeout-string"
  | "wasm";

/**
 * Per-script bundle: static analysis result plus a pointer into the
 * global event list. Events themselves live on {@link RuntimeReport.events}.
 */
export interface ScriptAnalysis {
  /** Display name (URL, or `eval-from-<host>-<sha-prefix>.js` for synthesized scripts). */
  name: string;
  /** SHA-256 of the script source. */
  sha256: string;
  /** Byte length. */
  bytes: number;
  /** How we got this script. */
  acquisition: ScriptAcquisition;
  /** Frame URLs where this script was observed (best effort). */
  frames: string[];
  /** Per-script forensic report from the static analyzer. */
  staticReport: Report;
  /**
   * Inclusive sequence range of runtime events attributed to this
   * script. `[null, null]` when no events fired from it.
   */
  eventRange: [number | null, number | null];
  /** Fraction of cataloged surfaces in `staticReport` that fired at runtime (0..1). */
  trapCoverage: number;
  /** On-disk path of the saved source. */
  savedTo: string | null;
}

// ─── Annotated finding ──────────────────────────────────────────────────────

/** A {@link Finding} tagged with where it came from. */
export interface AnnotatedFinding extends Finding {
  provenance: Provenance;
  /** Count of distinct call-site stacks across runtime hits. */
  callSites: number;
  /** Up to 3 representative stacks for human inspection. */
  sampleStacks: string[];
}

// ─── Report ─────────────────────────────────────────────────────────────────

export interface RuntimeReport {
  /** Always `REPORT_VERSION`. Increment on breaking changes. */
  reportVersion: typeof REPORT_VERSION;
  /** `script2builtins@<semver>` of the catalog that produced this report. */
  catalogVersion: string;
  /** SHA-256 of the injected trap script. */
  trapScriptSha256: string;
  /**
   * SHA-256 of the injected stealth shim, when `--stealth` was on.
   * `null` otherwise. Same purpose as `trapScriptSha256` — identifies
   * which exact shim ran so two reports under different stealth
   * configs are distinguishable.
   */
  stealthScriptSha256: string | null;
  /** Final URL (or `data:` for harness mode). */
  target: string;
  /** Run identifier (timestamp slug). */
  runId: string;
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601. */
  endedAt: string;
  /** Stringified navigation error if any. */
  navError: string | null;
  /** How the page was loaded — affects which platform APIs behave normally. */
  harnessMode: "url" | "data" | "file" | "http-harness";

  /** Canonical event list — single source of truth. */
  events: AnyRuntimeEvent[];

  /** Per-script bundles (references events by range). */
  scripts: ScriptAnalysis[];

  /** Runtime events reconstructed as RawAccess so {@link matchAccesses} can consume them. */
  reconstructedAccesses: RawAccess[];
  /** Same for sinks. */
  reconstructedSinks: NetworkSink[];
  /** Hazards observed at runtime (always concrete). */
  hazards: DynamicHazard[];

  /** Union of static + runtime findings with provenance per entry. */
  findings: AnnotatedFinding[];
  byCategory: Record<string, AnnotatedFinding[]>;

  summary: {
    totalScripts: number;
    networkScripts: number;
    inlineScripts: number;
    /** Scripts pulled out of `<iframe srcdoc>` attribute bodies. */
    srcdocScripts: number;
    evalScripts: number;
    totalAccesses: number;
    runtimeAccesses: number;
    staticAccesses: number;
    knownAccesses: number;
    botDetectionTells: number;
    sinkCount: number;
    leakedApiCount: number;
    runtimeCategories: string[];
    /** Keys observed at runtime that the static pass missed. */
    runtimeOnlyKeys: string[];
    /** Keys observed statically that runtime never fired. */
    staticOnlyKeys: string[];
    /** Pages already open when attach() was called and therefore not instrumented. */
    preExistingPages: number;
    /** Number of times the in-page event buffer dropped events to stay under cap. */
    bufferOverflows: number;
    /**
     * Drops broken down by event kind. A non-zero `sink` or `hazard`
     * here means high-signal events were lost — raise `bufferByteCap`
     * or pre-filter access events.
     */
    bufferOverflowsByKind: { access: number; sink: number; hazard: number };
    /**
     * D14: how many times the in-page trap flushed its buffer through
     * the Playwright `exposeBinding` channel before drop-oldest would
     * have kicked in. A non-zero value means rotation is happening
     * through the lossless push path; comparing this to
     * `bufferOverflows` tells you what fraction of the rotation
     * pressure the binding absorbed.
     */
    pushFlushes: number;
    /**
     * D14: total events delivered to the Node side via the push
     * binding (cumulative). Disjoint from the pull-drain stream — both
     * paths contribute to {@link RuntimeReport.events}, merged and
     * deduped by `seq`.
     */
    pushedEvents: number;
  };
}

// ─── Options ────────────────────────────────────────────────────────────────

/** Options safe to apply to a {@link BrowserContext} owned by the caller. */
export interface AttachOptions {
  /** Output directory for captured scripts + report artifacts. Required. */
  outDir: string;
  /** Per-event stack frame cap. Default 8. */
  stackLimit?: number;
  /** Captured body preview cap (bytes). Default 32 KiB. */
  bodyPreviewLimit?: number;
  /** Per-event-buffer byte cap before drop-oldest kicks in. Default 16 MiB. */
  bufferByteCap?: number;
  /** Per-event eval source cap (bytes). Default 256 KiB. */
  evalSourceCap?: number;
  /** Recursion-depth cap for eval-inside-eval. Default 10. */
  evalRecursionDepth?: number;
  /** Install eval/Function/setTimeout-string traps. Default true. */
  trapDynamicExec?: boolean;
  /** Install Proxy-wrapped roots (vs descriptor-only). Default true. */
  useProxyRoots?: boolean;
  /** Mask wrappers via Function.prototype.toString patch. Default true. */
  hardenIntrospection?: boolean;
  /**
   * Wrap `Reflect.get` to catch accesses on non-Proxy root references
   * (e.g. when a script grabbed `Object.getOwnPropertyDescriptor(window,
   * ...).value` before the Proxy went in). **On by default.** The
   * driver applies a `node_modules`-shaped stack-frame filter to keep
   * the report readable. Pass `false` for low-overhead runs on hot
   * pages.
   */
  trapReflectGet?: boolean;
  /**
   * Wrap `Worker` constructors to also boot the trap inside the
   * worker scope. Skipped for `{type: "module"}` workers and
   * `SharedWorker`. Default true.
   */
  trapWorkers?: boolean;
  /**
   * Override the `globalThis` property name the driver uses to ferry
   * the worker-trap source into worker scope. Default: per-attach
   * random (`__s2bwt_<6 hex>`). Surfaced on
   * {@link Session.workerTrapGlobalName} so stealth shims can dodge it.
   */
  workerTrapGlobalName?: string;
  /**
   * Install the stealth shim (`docs/stealth-mode.md`) as an
   * `addInitScript` before the trap runs. Pass `true` to use the
   * defaults, or an object to tune which surfaces are patched.
   *
   * The shim normalizes a small set of `navigator` / `Notification`
   * surfaces that headless Chromium gets wrong. **It does not make
   * the trap itself stealthy** — see `docs/limits.md` §7. Default
   * off; the runtime is research-grade, not a scraping toolkit.
   */
  stealth?: boolean | StealthOptions;
  /** Forward in-page console.debug from the trap to Node stderr. Default false. */
  verbose?: boolean;
  /** Categories of trap to install. Default: all. */
  trapCategories?: string[];
  /**
   * Override the in-page channel name on `window`. Default: per-attach
   * random (`__s2b_<6 hex bytes>`). Specify only when you need a
   * stable name for external observation.
   */
  channelName?: string;
}

/** Options that also drive a `browser.newContext` + navigation in {@link run}. */
export interface RunOptions extends AttachOptions {
  url: string;
  headless?: boolean;
  navTimeoutMs?: number;
  postNavIdleMs?: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
  cookies?: Array<{ name: string; value: string; domain: string; path?: string }>;
  extraHeaders?: Record<string, string>;
  /** When using runHarness internally: how the harness HTML was served. */
  harnessMode?: RuntimeReport["harnessMode"];
}

// ─── Session handle returned by attach() ────────────────────────────────────

export interface Session {
  /** Drain events (optionally incremental) and produce a report. */
  report(opts?: { since?: number; flush?: boolean }): Promise<RuntimeReport>;
  /** Latest seen sequence number. */
  readonly cursor: number;
  /** Remove listeners. Pages already opened stay instrumented until closed. */
  detach(): Promise<void>;
  /** SHA-256 of the injected trap script. */
  readonly trapScriptSha256: string;
  /**
   * The `window.<name>` channel the trap installed. Random per attach
   * unless overridden via {@link AttachOptions.channelName}. Surface so
   * callers can drain the channel from custom contexts (e.g. for
   * verbose tracing).
   */
  readonly channelName: string;
  /**
   * The `globalThis[<name>]` slot the driver writes the worker-trap
   * source into. Random per attach unless overridden via
   * {@link AttachOptions.workerTrapGlobalName}. A user-supplied
   * stealth shim should read this so it doesn't enumerate
   * `globalThis` and trip over the trap's own marker.
   */
  readonly workerTrapGlobalName: string;
  /**
   * SHA-256 of the stealth shim, when `attach` was called with
   * `stealth` set. `null` otherwise.
   */
  readonly stealthScriptSha256: string | null;
}

export type {
  ApiDefinition,
  DynamicHazard,
  Finding,
  Location,
  NetworkSink,
  ParseInfo,
  RawAccess,
  Report,
  StealthOptions,
};
