/**
 * Trap-script builder.
 *
 * Produces a single self-contained string suitable for
 * `BrowserContext.addInitScript`. The script:
 *
 *   - snapshots pristine references at the top
 *   - Proxy-wraps each root in {@link watchedRoots}
 *   - patches descriptors on each watched prototype
 *   - wraps every network sink
 *   - traps eval/Function/setTimeout-string when enabled
 *   - masks itself via Function.prototype.toString when hardened
 *
 * The output is deterministic for a given catalog version + options,
 * so its SHA-256 is meaningful as an identity marker for the
 * instrumentation that produced a report.
 */
import { createHash, randomBytes } from "node:crypto";
import { trapMain, type TrapConfig } from "./runtime.js";
import { watchedRoots, ALL_APIS } from "script2builtins-knowledge";

/**
 * Prototypes the trap script will iterate and wrap methods/getters on.
 *
 * Notably **omitted**: Navigator.prototype, Screen.prototype,
 * Document.prototype, Location.prototype, History.prototype,
 * Performance.prototype. Their cataloged accesses are caught via the
 * root Proxy on `navigator`, `screen`, etc. Patching their prototypes
 * AND Proxy-wrapping the root produces duplicate events and triggers
 * "Illegal invocation" when our patched native getters are called via
 * the Proxy receiver.
 */
export const WATCHED_PROTOTYPES = [
  "HTMLCanvasElement.prototype",
  "OffscreenCanvas.prototype",
  "CanvasRenderingContext2D.prototype",
  "OffscreenCanvasRenderingContext2D.prototype",
  "WebGLRenderingContext.prototype",
  "WebGL2RenderingContext.prototype",
  "AudioContext.prototype",
  "OfflineAudioContext.prototype",
  "AudioBuffer.prototype",
  "AudioNode.prototype",
  "AudioWorklet.prototype",
  "RTCPeerConnection.prototype",
  "RTCDataChannel.prototype",
  "Element.prototype",
  "HTMLElement.prototype",
  "MediaCapabilities.prototype",
  "TextMetrics.prototype",
  "Range.prototype",
  "SVGGraphicsElement.prototype",
  "SVGTextContentElement.prototype",
  "CSSStyleDeclaration.prototype",
  "FontFaceSet.prototype",
  "MediaSource.prototype",
  "MediaRecorder.prototype",
] as const;

export interface TrapBuildOptions {
  /** Restrict to a subset of catalog categories. Default: all. */
  categories?: string[];
  /** Per-event stack-frame cap. */
  stackLimit?: number;
  /** Body preview cap for sink events (bytes). */
  bodyPreviewLimit?: number;
  /** Buffer byte cap before drop-oldest. */
  bufferByteCap?: number;
  /** Eval source string cap (bytes). */
  evalSourceCap?: number;
  /** Recursion-depth cap for eval-inside-eval. */
  evalRecursionDepth?: number;
  /**
   * Drain-channel name on `window`. Default: per-build random
   * `__s2b_<6 hex bytes>`. Override only when you need a stable name
   * (e.g. for unit tests that read the channel from outside via a
   * `vm.runInContext` sandbox).
   */
  channelName?: string;
  /** Install Proxy roots (vs descriptor-only). */
  useProxyRoots?: boolean;
  /** Install eval/Function/setTimeout-string traps. */
  trapDynamicExec?: boolean;
  /** Mask wrappers via toString. */
  hardenIntrospection?: boolean;
  /**
   * Wrap `Reflect.get` to surface accesses on direct (non-Proxy) root
   * references. **On by default** — catches a class of fingerprint
   * reads that bypass the descriptor / Proxy paths (notably when a
   * script grabs an early reference to a real root via
   * `Object.getOwnPropertyDescriptor(window, ...).value`). The driver
   * filters `via: "reflect"` events whose top stack frame is
   * `node_modules`-shaped to keep the report clean. Pass `false` for
   * low-overhead runs on very hot pages.
   */
  trapReflectGet?: boolean;
  /**
   * Wrap classic `Worker` constructors to also boot the trap inside
   * the worker scope. Module workers and `SharedWorker` are skipped.
   * Requires the driver to inject the trap source as
   * `globalThis[workerTrapGlobalName]` via a sibling init script
   * (`attach()` handles this automatically). Default true.
   */
  trapWorkers?: boolean;
  /**
   * Name of the `globalThis` property the driver writes the
   * worker-trap source to. Default: per-build random
   * `__s2bwt_<6 hex>`. Surfaced on {@link Session.workerTrapGlobalName}
   * so stealth shims can dodge it.
   */
  workerTrapGlobalName?: string;
  /** Forward in-page console.debug. */
  verbose?: boolean;
}

export interface BuiltTrapScript {
  /** The wrapped IIFE source, ready for addInitScript. */
  source: string;
  /** SHA-256 of `source` — identity marker for this instrumentation. */
  sha256: string;
  /** Trap-script semver. */
  version: string;
  /** Config that was baked in. */
  config: TrapConfig;
}

const TRAP_VERSION = "1.0.0";

/**
 * Picked at build time. Hides the channel from a page that defensively
 * checks for `window.__s2bRt`. The name still has a stable `__s2b_`
 * prefix so a human reading a heap dump can recognize it.
 */
function defaultChannelName(): string {
  return `__s2b_${randomBytes(6).toString("hex")}`;
}

function defaultWorkerTrapGlobalName(): string {
  return `__s2bwt_${randomBytes(6).toString("hex")}`;
}

const DEFAULTS: Required<Omit<TrapBuildOptions, "categories" | "channelName" | "workerTrapGlobalName">> = {
  stackLimit: 8,
  bodyPreviewLimit: 32 * 1024,
  bufferByteCap: 16 * 1024 * 1024,
  evalSourceCap: 256 * 1024,
  evalRecursionDepth: 10,
  useProxyRoots: true,
  trapDynamicExec: true,
  hardenIntrospection: true,
  trapReflectGet: true,
  trapWorkers: true,
  verbose: false,
};

/**
 * Build the trap script. The returned `source` is a single IIFE
 * suitable for {@link BrowserContext.addInitScript}.
 */
export function buildTrapScript(opts: TrapBuildOptions = {}): BuiltTrapScript {
  const filteredApis = opts.categories
    ? ALL_APIS.filter((a) => opts.categories!.includes(a.category))
    : ALL_APIS;
  // Sort for determinism — same catalog → same hash.
  const roots = [...watchedRoots(filteredApis)].sort();
  const protos = [...WATCHED_PROTOTYPES].sort();

  const config: TrapConfig = {
    watchedRoots: roots,
    watchedPrototypes: protos,
    stackLimit: opts.stackLimit ?? DEFAULTS.stackLimit,
    bodyPreviewLimit: opts.bodyPreviewLimit ?? DEFAULTS.bodyPreviewLimit,
    bufferByteCap: opts.bufferByteCap ?? DEFAULTS.bufferByteCap,
    evalSourceCap: opts.evalSourceCap ?? DEFAULTS.evalSourceCap,
    evalRecursionDepth: opts.evalRecursionDepth ?? DEFAULTS.evalRecursionDepth,
    channelName: opts.channelName ?? defaultChannelName(),
    useProxyRoots: opts.useProxyRoots ?? DEFAULTS.useProxyRoots,
    trapDynamicExec: opts.trapDynamicExec ?? DEFAULTS.trapDynamicExec,
    hardenIntrospection: opts.hardenIntrospection ?? DEFAULTS.hardenIntrospection,
    trapReflectGet: opts.trapReflectGet ?? DEFAULTS.trapReflectGet,
    trapWorkers: opts.trapWorkers ?? DEFAULTS.trapWorkers,
    workerTrapGlobalName: opts.workerTrapGlobalName ?? defaultWorkerTrapGlobalName(),
    verbose: opts.verbose ?? DEFAULTS.verbose,
    trapHash: "", // placeholder, replaced after hashing
    version: TRAP_VERSION,
  };

  const fnSource = trapMain.toString();

  // Round 1: compute hash with empty trapHash field.
  const provisionalConfigJson = JSON.stringify(config);
  const provisional = `;(${fnSource})(${provisionalConfigJson});`;
  const sha256 = createHash("sha256").update(provisional).digest("hex");

  // Round 2: bake the hash into the config so the in-page channel
  // can self-identify.
  config.trapHash = sha256;
  const finalConfigJson = JSON.stringify(config);
  const source = `;(${fnSource})(${finalConfigJson});`;

  return { source, sha256, version: TRAP_VERSION, config };
}
