import type { ApiDefinition } from "../types.js";

/**
 * Workers + OffscreenCanvas. Two reasons fingerprinters spawn workers:
 *
 * 1. **Spoof consistency check.** Re-read navigator.userAgent, .platform,
 *    .hardwareConcurrency, .deviceMemory, .languages, Intl.* from worker
 *    scope and compare with the main thread. Many stealth shims only
 *    patch the main-thread `navigator`, leaving the worker side untouched.
 *    A mismatch is a high-severity tell.
 *
 * 2. **Headless tells.** OffscreenCanvas + WebGL in a worker reveals the
 *    GPU renderer even if the main thread blocks getParameter — and the
 *    main-vs-worker renderer strings should match.
 *
 * 3. **Self-script size.** Some detectors fetch their own script URL,
 *    read .size on the Blob, and verify against an expected length to
 *    detect tampered/proxied source.
 */
export const workerApis: ApiDefinition[] = [
  {
    key: "Worker",
    category: "workers",
    severity: "medium",
    botDetectionTell: true,
    description: "Dedicated Worker constructor. Frequently used by detectors to re-probe navigator/Intl from an unpatched realm.",
    evasion: "Inject the same overrides into Worker scope. Patch the Worker constructor to wrap the script URL or transparently rewrite the worker source.",
  },
  {
    key: "SharedWorker",
    category: "workers",
    severity: "medium",
    botDetectionTell: true,
    description: "Cross-tab worker. Same dual-realm fingerprint risk as Worker; less commonly hooked.",
  },
  {
    key: "ServiceWorker",
    category: "workers",
    severity: "low",
    description: "ServiceWorker interface; capability probe.",
  },
  {
    key: "ServiceWorkerContainer",
    category: "workers",
    severity: "low",
    description: "navigator.serviceWorker. .register / .ready / .controller form an exfiltration / persistence axis.",
  },
  {
    key: "*.register",
    category: "workers",
    severity: "medium",
    botDetectionTell: true,
    description: "navigator.serviceWorker.register(url). Installs a SW — the persistence-vector entry point (2020 Awakening the Web's Sleeper Agents). The URL also leaks the SW script name, which detectors use for cache-key derivation; SWs outlive the page and continue probing in the background.",
  },
  {
    key: "importScripts",
    category: "workers",
    severity: "medium",
    botDetectionTell: true,
    description: "WorkerGlobalScope.importScripts. Used to load additional detection logic inside a worker context.",
  },
  {
    key: "OffscreenCanvas",
    category: "workers",
    severity: "high",
    botDetectionTell: true,
    description: "Worker-side canvas constructor. getContext('webgl') on an OffscreenCanvas inside a Worker reveals the GPU even when main-thread getParameter is patched.",
    evasion: "Patch OffscreenCanvasRenderingContext2D and OffscreenCanvas.prototype.getContext as well; inject overrides into Worker scope.",
  },
  {
    key: "WorkerNavigator",
    category: "workers",
    severity: "high",
    botDetectionTell: true,
    description: "Worker-scope navigator. Detectors compare WorkerNavigator.userAgent / .platform / .hardwareConcurrency / .deviceMemory / .languages with main-thread values; mismatch = spoof.",
  },
  {
    key: "Blob",
    category: "workers",
    severity: "low",
    description: "Blob constructor. fingerprinters build worker source as a Blob + URL.createObjectURL to dodge cross-origin script restrictions.",
  },
  {
    key: "URL.createObjectURL",
    category: "workers",
    severity: "low",
    description: "Companion to Blob; URL for the worker source.",
  },
];
