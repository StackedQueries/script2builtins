---
title: Static vs runtime
nav_order: 4
---

# Static vs runtime — what each pass sees

`script2builtins` (static) and `script2builtins-runtime` (dynamic)
complement each other. Each one has a class of finding the other
cannot produce. The unified report tags every finding with
`provenance: "static" | "runtime" | "static+runtime"` so you can read
that disagreement directly.

## The blind-spot table

| Surface                                                     | Static | Runtime |
|-------------------------------------------------------------|--------|---------|
| Direct property access (`navigator.userAgent`)              | ✅     | ✅      |
| Aliased access (`var n = navigator; n.webdriver`)           | ✅     | ✅      |
| Computed key with static string (`navigator["userAgent"]`)  | ✅     | ✅      |
| Computed key from concat (`navigator["user" + "Agent"]`)    | ✅     | ✅      |
| Computed key from `atob(...)` / deobfuscated lookup table   | partial| ✅      |
| Fully dynamic key (`navigator[obfuscate(0x1a3)]`)           | ❌     | ✅      |
| `Reflect.get(navigator, "webdriver")`                       | partial| ✅      |
| `Object.getOwnPropertyDescriptor(...).get.call(navigator)`  | partial| ✅      |
| Code constructed inside `eval(str)`                         | ❌     | ✅      |
| Code constructed inside `new Function(str)`                 | ❌     | ✅      |
| `setTimeout("string code", ...)`                            | ❌     | ✅      |
| Anti-debug `debugger` traps                                 | detect | bypass  |
| `Function.prototype.toString` byte-pattern checks           | detect | bypass  |
| Dead code (declared but never run)                          | ✅     | ❌      |
| Untaken branches (e.g., `if (UA matches X)` only-on-Safari) | ✅     | ❌      |
| Code that never loads (CSP block, 404)                      | ✅     | ❌      |
| Per-build-target inlined constants                          | ✅     | ✅      |
| Runtime-only values (canvas hash, audio fingerprint)        | ❌     | ✅      |
| Sink URL constructed at call time                           | partial| ✅      |
| Sink body constructed at call time                          | partial| ✅      |

The `partial` cells are surfaces where the static analyzer emits an
access (with `hasDynamicSegment: true` or as a known idiom matcher)
but doesn't know the concrete value — the runtime fills in the value.

## Why static still matters

Three reasons to keep the static pass in your pipeline even when you
also run the runtime:

1. **Coverage of code that never ran.** Detectors often ship a
   superset of checks and only enable some per user-agent / per A/B
   slot. The static pass enumerates the full set; the runtime tells
   you which slot you fell into. The `staticOnlyKeys` in the report
   summary is the diff.
2. **No browser cost for a quick read.** Reading a 5KB detector
   statically is a millisecond. Running it is a 30-second browser
   round-trip plus the cost of capturing the captcha challenges it
   throws.
3. **Reading the trap script vs running it.** When you're trying to
   *patch* a detector (build a stealth automation tool), you want the
   call graph the static pass produces. The runtime gives you the call
   *traces* — useful for confirming the patch, less useful for designing
   it.

## Why runtime still matters

The mirror argument:

1. **The eval blob.** A non-trivial fraction of modern detectors ship
   ~80% of their logic inside a string passed to `new Function(...)`
   that's decrypted with a per-page key. Static sees nothing inside
   that string; runtime sees the constructed source and recurses on
   it.
2. **The real exfiltrated body.** Static can trace
   `JSON.stringify({ ua: navigator.userAgent })` to its source chain.
   It cannot trace a value that comes out of a Web Worker, gets
   transformed through three layers of obfuscation, and lands in
   `fetch(...)` as a base64-encoded payload. Runtime captures the
   bytes that hit the wire.
3. **The actual sink URL.** When the URL is
   `domain.com/collect/${randomToken()}/${navigator.userAgent}`, static
   gives you the snippet; runtime gives you the URL as the server
   saw it.

## Read the report

A unified runtime report contains a top-level `summary`:

```json
{
  "summary": {
    "totalScripts": 14,
    "networkScripts": 12,
    "inlineScripts": 2,
    "srcdocScripts": 0,
    "evalScripts": 5,
    "totalAccesses": 1842,
    "runtimeAccesses": 1230,
    "staticAccesses": 612,
    "knownAccesses": 540,
    "botDetectionTells": 41,
    "sinkCount": 12,
    "leakedApiCount": 28,
    "runtimeOnlyKeys": ["navigator.webdriver", "Function.prototype.toString", ...],
    "staticOnlyKeys": ["navigator.brave", "Atomics.wait", ...],
    "preExistingPages": 0,
    "bufferOverflows": 0,
    "bufferOverflowsByKind": { "access": 0, "sink": 0, "hazard": 0 }
  }
}
```

- `runtimeOnlyKeys` is **the eval blob plus dynamic-key reads** —
  surfaces only visible because we ran the script.
- `staticOnlyKeys` is **dead code and untaken branches** — surfaces
  declared but not executed on this load.
- `leakedApiCount` is **the union of fingerprint surfaces that
  actually crossed the wire** — populated for runtime sinks via
  `parseRuntimeBody` (the in-page trap captures the body preview;
  the driver re-parses it on the Node side through the same payload
  parser the static path uses).
- `srcdocScripts` is captures from `<iframe srcdoc>` attributes; the
  driver pulls `<script>` bodies out of the srcdoc HTML and runs them
  through the static analyzer.
- `bufferOverflowsByKind` is non-zero when the in-page event buffer
  hit its cap and dropped events. `sink` / `hazard` drops are
  high-signal losses — raise `bufferByteCap` or pre-filter access
  events.

The combination tells you the actual surface area of the detector for
this run, and the headroom of surfaces it could probe under different
conditions.
