import type { ApiDefinition } from "./types.js";

/**
 * Console API surface, with a slant toward anti-logger / anti-debug
 * patterns. Botguard and similar VM-based detectors override `console.*`
 * methods to install seed-mutation traps: any external `console.log` of
 * a VM-internal variable shifts a memory pointer and corrupts the
 * resulting attestation token (Kits Kärneriks §3 "Chronometric Defense
 * (Anti-Debug)" and "The Anti-Logger"). The same pattern shows up in
 * commodity packers that wrap `console.error` to detect DevTools
 * formatters that stringify Error objects synchronously.
 *
 * Catalog policy:
 *   - A read or call of `console.log` / `debug` / `warn` / `error`
 *     inside a detector blob is suspicious. Mark these as
 *     `botDetectionTell: true`.
 *   - The strongest signal is **assignment** (`console.log = fn`), but
 *     the static analyzer currently does not distinguish reads from
 *     assignments — descriptions note when the assignment form is the
 *     one to look for.
 *   - `console.profile` / `timeStamp` are DevTools-coupled and almost
 *     always appear in anti-debug paths; medium tells.
 */
export const consoleApis: ApiDefinition[] = [
  {
    key: "console.log",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    layer: "L3",
    description: "console.log access. In legit code it's a print statement; in a detector blob the same expression often appears on the LEFT of an assignment (`console.log = trap`) to install an anti-logger that mutates a VM seed when an analyst tries to inspect internals. Look at adjacent assignment ops.",
    evasion: "Capture console.log once at top of script and replay your patches against it; don't read through window.console after a detector loads.",
  },
  {
    key: "console.debug",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    layer: "L3",
    description: "console.debug. Same anti-logger axis as console.log. Botguard variants prefer .debug because some loggers filter the channel — overriding it specifically catches conditional-logpoint users who think they're being quiet.",
  },
  {
    key: "console.warn",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    layer: "L3",
    description: "console.warn. Frequently overridden alongside log/debug in anti-logger setups.",
  },
  {
    key: "console.error",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    layer: "L3",
    description: "console.error. DevTools formats Error objects synchronously, so wrapping .error gives the detector a hook to fire on uncaught exception logging — a clue that a debugger is attached.",
  },
  {
    key: "console.info",
    category: "anti-debug",
    severity: "low",
    description: "console.info. Less frequently the anti-logger target but worth surfacing.",
  },
  {
    key: "console.table",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    layer: "L3",
    description: "console.table. Synchronous DOM-style table render is a strong DevTools signal — Botguard-class blobs use it as a poor-man's `isDevToolsOpen()` (timing the call reveals whether a formatter is attached).",
  },
  {
    key: "console.dir",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    layer: "L3",
    description: "console.dir. Used to expand objects in DevTools; same anti-debug signal as console.table.",
  },
  {
    key: "console.dirxml",
    category: "anti-debug",
    severity: "low",
    description: "console.dirxml. Niche, but a few packers wrap this for symmetry with .dir.",
  },
  {
    key: "console.trace",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    layer: "L3",
    description: "console.trace. Reads the call stack — almost never legitimate in a fingerprinting detector; presence suggests it's being used to walk frames looking for puppeteer/playwright glue.",
  },
  {
    key: "console.profile",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    layer: "L3",
    description: "console.profile / profileEnd. DevTools-coupled performance API. Appearing inside detector logic strongly indicates an attempt to detect whether a profiler is attached (timing differences) or to confuse one (start a profile mid-VM to skew samples).",
  },
  {
    key: "console.profileEnd",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    description: "Companion to console.profile.",
  },
  {
    key: "console.timeStamp",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    description: "console.timeStamp. Drops a marker on the DevTools timeline. Same anti-profiler axis as console.profile.",
  },
  {
    key: "console.assert",
    category: "anti-debug",
    severity: "low",
    description: "console.assert. Sometimes wrapped to catch DevTools.",
  },
  {
    key: "console.clear",
    category: "anti-debug",
    severity: "low",
    description: "console.clear. Anti-analysis behavior: detector wipes the console after dumping debug data, so an analyst inspecting the log sees an empty buffer.",
    botDetectionTell: true,
  },
  {
    key: "console.group",
    category: "anti-debug",
    severity: "info",
    description: "console.group / groupCollapsed / groupEnd. Almost always benign.",
  },
  {
    key: "console.groupCollapsed",
    category: "anti-debug",
    severity: "info",
    description: "Same as console.group.",
  },
  {
    key: "console.groupEnd",
    category: "anti-debug",
    severity: "info",
    description: "Same as console.group.",
  },
  {
    key: "console.count",
    category: "anti-debug",
    severity: "info",
    description: "console.count.",
  },
  {
    key: "console.countReset",
    category: "anti-debug",
    severity: "info",
    description: "console.countReset.",
  },
  {
    key: "console.time",
    category: "anti-debug",
    severity: "low",
    description: "console.time / timeEnd. Pair forms an anti-debug timer when the delta is compared to a threshold (DevTools-attached formatters slow the call).",
  },
  {
    key: "console.timeEnd",
    category: "anti-debug",
    severity: "low",
    description: "Companion to console.time.",
  },
  {
    key: "console.timeLog",
    category: "anti-debug",
    severity: "info",
    description: "console.timeLog.",
  },
  {
    key: "console.memory",
    category: "anti-debug",
    severity: "medium",
    botDetectionTell: true,
    description: "Chrome-only `console.memory` getter (jsHeapSizeLimit etc.) — alternative entry to the performance.memory axis that some shims forget to spoof.",
  },
  // The `console` global itself is worth flagging when read as an
  // identifier (e.g. `var c = console; c.log = ...`) — that's the
  // de-facto signature of an aliased anti-logger setup.
  {
    key: "console",
    category: "anti-debug",
    severity: "low",
    description: "Bare console-global access. Almost always legitimate, but aliasing it to a local before overriding methods is a classic anti-logger setup; treat the alias + assignment pair as suspicious.",
  },
];
