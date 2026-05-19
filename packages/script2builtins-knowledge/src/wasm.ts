import type { ApiDefinition } from "./types.js";

/**
 * WebAssembly. Three fingerprint angles:
 *
 * 1. **Engine compile-time differences.** WebAssembly.compile of a known
 *    module produces engine-specific validation errors / tier-up timing.
 *    JavaScript Template Attacks (2019) showed this distinguishes V8/SM/JSC.
 *
 * 2. **CPU benchmarking.** Tight numeric loops inside a wasm module run
 *    at deterministic speeds, exposing CPU model + thermal state.
 *    `2022 - Browser-based CPU Fingerprinting` (dark-knowledge) uses wasm
 *    to time L1/L2/L3 cache behaviour.
 *
 * 3. **Capability probe.** Presence of WebAssembly.Memory.shared (threads),
 *    WebAssembly.tag (exception handling), and streaming APIs identifies
 *    Chrome version more reliably than UA.
 */
export const wasmApis: ApiDefinition[] = [
  {
    key: "WebAssembly",
    category: "wasm",
    severity: "low",
    description: "Root namespace; capability check.",
  },
  {
    key: "WebAssembly.compile",
    category: "wasm",
    severity: "medium",
    description: "Compiles a wasm module from bytes. Used in CPU-timing fingerprints.",
  },
  {
    key: "WebAssembly.compileStreaming",
    category: "wasm",
    severity: "medium",
    description: "Streaming compile from a Response. Browser-version probe.",
  },
  {
    key: "WebAssembly.instantiate",
    category: "wasm",
    severity: "medium",
    description: "Compile + instantiate. Tight inner loops within the instance leak CPU model.",
  },
  {
    key: "WebAssembly.instantiateStreaming",
    category: "wasm",
    severity: "medium",
    description: "Streaming instantiate.",
  },
  {
    key: "WebAssembly.validate",
    category: "wasm",
    severity: "low",
    description: "Validates wasm bytes without compiling.",
  },
  {
    key: "WebAssembly.Module",
    category: "wasm",
    severity: "medium",
    description: "Module constructor. Module.imports / Module.exports introspection.",
  },
  {
    key: "WebAssembly.Memory",
    category: "wasm",
    severity: "medium",
    description: "Memory constructor. .shared flag presence identifies cross-origin-isolated context.",
  },
  {
    key: "WebAssembly.Table",
    category: "wasm",
    severity: "low",
    description: "Function table constructor.",
  },
  {
    key: "WebAssembly.Global",
    category: "wasm",
    severity: "info",
    description: "Global value constructor.",
  },
  {
    key: "WebAssembly.Tag",
    category: "wasm",
    severity: "low",
    description: "Exception-handling proposal. Presence = Chrome 95+ / Firefox 100+.",
  },
  {
    key: "*.grow",
    category: "wasm",
    severity: "medium",
    description: "WebAssembly.Memory.grow(). The cost of growing memory exposes page-size and TLB behaviour — 16KB pages on Apple M1 vs 4KB on x86 is one fingerprint axis.",
    botDetectionTell: true,
  },
  {
    key: "SharedArrayBuffer",
    category: "wasm",
    severity: "high",
    botDetectionTell: true,
    description: "Shared memory buffer. Combined with a Worker incrementing a counter, gives sub-microsecond timers that bypass `performance.now()` quantization — the canonical timing-attack primitive in browsers. Requires crossOriginIsolated.",
    evasion: "Browsers gate SAB on COOP+COEP. A headless-Chrome instance set up without isolation has SAB unavailable; detectors then look for the inverse: SAB-available with non-default UA = spoof.",
  },
  {
    key: "Atomics.wait",
    category: "wasm",
    severity: "medium",
    description: "Thread-blocking primitive. Used with SharedArrayBuffer for inter-Worker sync.",
  },
  {
    key: "Atomics.notify",
    category: "wasm",
    severity: "medium",
    description: "Wake threads waiting on Atomics.wait.",
  },
  {
    key: "Atomics.load",
    category: "wasm",
    severity: "medium",
    description: "Atomic read from a SharedArrayBuffer. Heart of the busy-loop counter timer.",
  },
  {
    key: "Atomics.store",
    category: "wasm",
    severity: "medium",
    description: "Atomic write to SharedArrayBuffer.",
  },
  {
    key: "Atomics.add",
    category: "wasm",
    severity: "medium",
    description: "Atomic add. Counter-bump for SAB-timer worker.",
  },
];
