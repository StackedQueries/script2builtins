import type { ApiDefinition } from "../types.js";

export const storageFontsApis: ApiDefinition[] = [
  {
    key: "localStorage",
    category: "storage",
    severity: "low",
    description: "Persistent key/value store. Detectors stash device IDs / risk scores here for cross-session correlation.",
  },
  {
    key: "sessionStorage",
    category: "storage",
    severity: "info",
    description: "Tab-scoped storage; sometimes used to hold per-session detection state.",
  },
  {
    key: "indexedDB",
    category: "storage",
    severity: "low",
    description: "Larger persistent store; detectors use it for evercookies / device IDs.",
  },
  {
    key: "openDatabase",
    category: "storage",
    severity: "info",
    description: "Deprecated WebSQL. Capability presence still occasionally used.",
  },
  {
    key: "*.estimate",
    category: "storage",
    severity: "low",
    description: "navigator.storage.estimate() leaks rough disk quota — coarse but stable.",
  },

  {
    key: "FontFace",
    category: "fonts",
    severity: "medium",
    description: "Programmatic font registration; unusual outside fingerprinters.",
  },
  {
    key: "*.check",
    category: "fonts",
    severity: "medium",
    description: "document.fonts.check('12px Foo') tests a probe family — efficient font enumeration.",
  },
  {
    key: "*.load",
    category: "fonts",
    severity: "low",
    description: "document.fonts.load(); used both for font fingerprinting and benign loading.",
  },
  {
    key: "*.databases",
    category: "storage",
    severity: "medium",
    description: "indexedDB.databases(). Returns names of existing DBs — leaks 'returning visitor' status without a cookie.",
  },
  {
    key: "caches",
    category: "storage",
    severity: "low",
    description: "CacheStorage root. Same returning-visitor leak via caches.keys().",
  },
  {
    key: "*.keys",
    category: "storage",
    severity: "low",
    description: "caches.keys() (when on CacheStorage). Lists installed PWA caches.",
  },
  {
    key: "FontFaceSet",
    category: "fonts",
    severity: "info",
    description: "Constructor; rarely invoked directly but referenced in prototype probes.",
  },

  // ─── Service-worker / cache persistent tracking ────────────────────────────
  // 2020 - Awakening the Web's Sleeper Agents — service workers persist
  // tracking state across cookie clears; their cache + registration
  // surfaces are the primary persistence vectors.
  {
    key: "*.open",
    category: "storage",
    severity: "low",
    description: "caches.open(name). Opens a named Cache. Re-using a known name across visits is the most common SW-based persistent identifier.",
  },
  {
    key: "*.match",
    category: "storage",
    severity: "low",
    description: "caches.match(req) / cache.match(req). Read path — used by SW-based trackers to check whether a per-visitor cache entry already exists (returning-visitor signal).",
  },
  {
    key: "*.put",
    category: "storage",
    severity: "low",
    description: "cache.put(req, res). Stores a per-visitor response; combined with caches.match, the canonical evercookie path inside a SW.",
  },
  {
    key: "*.delete",
    category: "storage",
    severity: "info",
    description: "caches.delete / cache.delete. Removal probe; rarely fingerprint-load-bearing on its own.",
  },
  {
    key: "*.has",
    category: "storage",
    severity: "low",
    description: "caches.has(name). Existence probe — cheaper than open() for returning-visitor detection.",
  },
  {
    key: "BroadcastChannel",
    category: "storage",
    severity: "medium",
    description: "BroadcastChannel constructor. Used by SW-based cross-tab tracking to coordinate session-state without storage events. Presence in a fingerprint blob is suspicious because there's no benign reason for a detector to need cross-tab messaging.",
    botDetectionTell: true,
  },
  {
    key: "*.postMessage",
    category: "storage",
    severity: "low",
    description: "MessagePort/BroadcastChannel/Window.postMessage. Cross-realm exfiltration channel — Botguard's PO-Token flow uses this to push attested tokens to a hidden iframe before they get sent over the wire.",
  },
  {
    key: "ServiceWorkerRegistration",
    category: "storage",
    severity: "low",
    description: "Constructor reference. Detectors usually receive a registration from navigator.serviceWorker.register, not by constructing one.",
  },
  // serviceWorker.register lives in workers.ts as `*.register`; the
  // persistence-vector framing the A3 entry added now lives on that
  // entry's description.
  {
    key: "*.controller",
    category: "storage",
    severity: "low",
    description: "navigator.serviceWorker.controller. Non-null means a SW is already controlling the page — returning-visitor / persistent-session tell.",
  },
  {
    key: "*.scope",
    category: "storage",
    severity: "info",
    description: "ServiceWorkerRegistration.scope. Reveals the URL pattern the SW controls.",
  },
  {
    key: "*.ready",
    category: "storage",
    severity: "info",
    description: "navigator.serviceWorker.ready. Awaitable that resolves once the active SW is in control.",
  },
];
