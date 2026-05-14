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
];
