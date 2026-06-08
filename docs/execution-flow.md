---
title: Execution flow
nav_order: 3
---

# Execution flow

Diagrams of how data moves through the system. Read this alongside
[Architecture](architecture.html) (which describes *what* the parts
are) and [Trap internals](trap-internals.html) (which describes *how*
the in-page trap script is built).

Each diagram is ASCII for portability — straight Markdown, no external
tooling needed to read this page.

---

## Diagram index

1. [CLI dispatch — input shape → engine](#1-cli-dispatch)
2. [`run({url})` lifecycle — turn-key mode](#2-run-lifecycle)
3. [`attach(context)` lifecycle — embedded mode](#3-attach-lifecycle)
4. [Trap-script boot sequence — what happens in the page](#4-trap-script-boot)
5. [Single trap fire — one event from access to report](#5-single-trap-fire)
6. [Drain + reconstruction — events into catalog matches](#6-drain-and-reconstruction)
7. [Static + runtime merge — provenance computation](#7-static-runtime-merge)
8. [eval recursion — capturing constructed source](#8-eval-recursion)
9. [Per-script bundle layout — what lands on disk](#9-per-script-bundle)

---

## 1. CLI dispatch

The `s2b` binary routes by input shape and flags before any engine
code loads:

```
┌──────────────────────────────────────────────────────────────────────┐
│                          $ s2b <input> [flags]                       │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │  parseArgs(argv)     │
                   └──────────┬───────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
       starts with        is "-"            is file path
       http(s)://         (stdin)
            │                 │                 │
   ┌────────┴────────┐        │                 │
   │                 │        │                 │
   │  --static-only? │        │                 │
   │                 │        │                 │
   yes              no        │                 │
   │                 │        │                 │
   ▼                 ▼        ▼                 │
┌──────────┐  ┌──────────┐  ┌──────────┐   ┌────┴─────┐
│ fetch +  │  │ launch   │  │ read     │   │ --dynamic│
│ analyze  │  │ browser  │  │ stdin +  │   │ ?        │
│          │  │ on URL   │  │ analyze  │   └────┬─────┘
└────┬─────┘  └────┬─────┘  └────┬─────┘        │
     │             │              │        ┌────┴────┐
     │             │              │       yes       no
     │             │              │        │         │
     │             │              │        ▼         ▼
     │             │              │   ┌─────────┐ ┌────────┐
     │             │              │   │ wrap in │ │ read   │
     │             │              │   │ harness │ │ file + │
     │             │              │   │ + drive │ │ analyze│
     │             │              │   │ browser │ │        │
     │             │              │   └────┬────┘ └───┬────┘
     │             │              │        │          │
     ▼             ▼              ▼        ▼          ▼
   ┌────────────────────────────────────────────────────────┐
   │            renderText | renderRuntimeText              │
   │            JSON or human-readable to stdout            │
   └────────────────────────────────────────────────────────┘
```

The runtime engine only loads when one of the three dynamic branches
is taken — static-only invocations don't pay the Playwright import
cost.

---

## 2. `run()` lifecycle

The turn-key path. One function call goes from URL to report.

```
   ┌─────────────────────────────┐
   │  run({ url, outDir, ... })  │
   └──────────────┬──────────────┘
                  │
                  ▼
   ┌─────────────────────────────────────┐
   │  chromium.launch({ headless })      │
   │  browser.newContext({ ua, viewport })│
   └──────────────┬──────────────────────┘
                  │
                  ▼
   ┌─────────────────────────────┐
   │  session = attach(context)  │  ◄── core primitive
   └──────────────┬──────────────┘
                  │
                  ▼
   ┌─────────────────────────────┐
   │  context.newPage()          │
   │  page.goto(url)             │
   └──────────────┬──────────────┘
                  │
                  ▼
   ┌─────────────────────────────┐
   │  wait postNavIdleMs         │
   │  (let late blobs run)       │
   └──────────────┬──────────────┘
                  │
                  ▼
   ┌─────────────────────────────┐
   │  report = await session     │
   │    .report({ flush: true }) │
   └──────────────┬──────────────┘
                  │
                  ▼
   ┌─────────────────────────────┐
   │  write per-script artifacts │
   │  write summary, manifest    │
   │  browser.close()            │
   └──────────────┬──────────────┘
                  │
                  ▼
            returns RuntimeReport
```

`run()` is ~30 lines of orchestration. All the interesting work is in
`attach()` and `session.report()`.

---

## 3. `attach()` lifecycle

The embedded path. You own the context and the page lifecycle; we own
the instrumentation and the reporting.

```
   you                              s2b-runtime
   ─────                            ───────────
   await chromium.launch()
   await browser.newContext()
        │
        ▼
   const session = await attach(context, opts)
                                    │
                                    ▼
                       ┌────────────────────────────┐
                       │ buildTrapScript(opts)       │  catalog-driven
                       └─────────────┬──────────────┘
                                    │
                                    ▼
                       ┌────────────────────────────┐
                       │ context.addInitScript(src) │
                       │ context.on("requestfinished", capture) │
                       │ context.on("page", attachPage)         │
                       └─────────────┬──────────────┘
                                    │
   await context.newPage()           │
        │                            │
        ▼                            │
   page.goto(url)                    │  ◄── traps run before page scripts
   ... your automation ...           │
        │                            │
        ▼                            │
   const r1 = await session.report() │
                                    │  drain events from every page
                                    │  reconstruct RawAccess/NetworkSink
                                    │  merge with static
                                    ▼
                              r1: RuntimeReport (cursor = N1)
   ... more automation ...          │
        │                            │
        ▼                            │
   const r2 = await session.report({ since: N1 })
                                    │  drain events since N1 only
                                    ▼
                              r2: RuntimeReport (cursor = N2)
        │
        ▼
   await session.detach()
                                    │
                                    ▼
                              flush, write artifacts,
                              remove listeners
```

Three properties of this design worth pointing out:

- The `requestfinished` listener is attached at context level, so
  pages opened later are still captured.
- Reports are stateless — `session.report()` doesn't mutate the
  session; you can call it as often as you want.
- `since` is a sequence number, not a timestamp — replay-safe.

---

## 4. Trap-script boot

What happens inside the page when `addInitScript` fires. The numbered
steps run sequentially before any page `<script>` executes.

```
   ┌─────────────────────────────────────────────────────────────────┐
   │                  trap script (auto-generated)                   │
   └─────────────────────────────────────────────────────────────────┘
                                  │
   ① Snapshot pristine refs        │
      ──────────────────────       ▼
      __$ = { Object, Reflect, Proxy, Function,
              fnCall, fnApply, defineProperty,
              getOwnDescriptor, performance: { now },
              Error, WeakMap, Map, Set, Array }
                                  │
   ② Init event buffer            ▼
      ──────────────              events = []
                                  seq = 0
                                  bytes = 0
                                  overflows = 0
                                  │
   ③ Generate root Proxies         ▼
      ────────────────────       for each root in watchedRoots():
                                    install Proxy wrapper around
                                    window.<root>
                                  │
   ④ Patch prototype descriptors  ▼
      ─────────────────────       for each "*.method" in ALL_APIS:
                                    patch the method on its
                                    known prototypes
                                  │
   ⑤ Wrap sinks                   ▼
      ────────────                for each NetworkSinkKind:
                                    install the kind's wrapper
                                  │
   ⑥ Wrap dynamic exec            ▼
      ─────────────────           wrap eval, Function, setTimeout,
                                  setInterval, import()
                                  │
   ⑦ Mask introspection           ▼
      ───────────────────         patch Function.prototype.toString
                                  to return [native code] for our
                                  wrappers
                                  │
   ⑧ Expose drain channel         ▼
      ──────────────────          window[config.channelName] = {
                                    drain(since), flush(), cursor,
                                    bufferOverflows,
                                    bufferOverflowsByKind,
                                    sectionErrors,
                                    version, trapHash
                                  }
                                  (channelName is `__s2b_<6 hex>`
                                   per-build random by default;
                                   Session.channelName exposes it)
                                  │
                                  ▼
                          (page scripts run, traps fire)
```

Worker bootstrap (when `trapWorkers: true`): the driver injects a
sibling init script *before* the main trap that publishes the trap
source as `globalThis.__s2bWorkerTrap`. The main trap reads this and
creates a blob URL the wrapped Worker constructor uses for the
bootstrap. See [Trap internals](trap-internals.html#worker-instrumentation-phase-8).

Each step uses only `__$`-snapshotted globals. A page script that
runs after this and replaces `window.Object` cannot affect the trap.

---

## 5. Single trap fire

What happens between `navigator.webdriver` being read by a page
script and the corresponding `Finding` being emitted in the final
report. All times are illustrative.

```
   page script @t=12.4ms                trap                Node driver
   ──────────────────────               ────                ────────────

   if (navigator.webdriver) { ... }
                │
                │ ▼ Proxy "get" trap fires
                │
                │  push({
                │    kind: "access",
                │    chain: ["navigator", "webdriver"],
                │    called: false,
                │    firstStringArg: null,
                │    via: "proxy",
                │    scriptUrl:
                │      parseStack(new Error().stack),
                │    seq: 412,
                │    t: 12.4,
                │  })
                │
                │  events.push(...)
                │  (returns the property value to the page script)

   ... more page execution ...

                                     await session.report()
                                            │
                                            ▼
                                     await page.evaluate(
                                       () => window[channelName]
                                              .drain(cursor)
                                     )
                                            │
                                            ▼
                                     events.splice(0) returned
                                            │
                                            ▼
                                     for each event:
                                       backfill scriptSha256
                                         using url → sha map
                                       parse stack
                                            │
                                            ▼
                                     RawAccess[] reconstructed:
                                       chain: ["navigator","webdriver"]
                                       called: false
                                       loc:   {line:1,column:3,...}
                                       resolvedThroughObfuscation: false
                                       hasDynamicSegment: false
                                            │
                                            ▼
                                     matchAccesses(raw, ALL_APIS)
                                            │
                                            ▼
                                     Finding:
                                       api: { key:"navigator.webdriver",
                                              severity:"high",
                                              botDetectionTell:true, ... }
                                       count: 1
                                       hits: [raw]
                                            │
                                            ▼
                                     AnnotatedFinding:
                                       provenance: "static+runtime"
                                            │ (if also seen in source)
                                            │ or "runtime"
                                            │ (if eval-only)
                                            ▼
                                       merged into report.findings
```

The matcher (`matchAccesses`) is the same code path the static
analyzer uses. The runtime layer just converts events into the
shape the matcher expects.

---

## 6. Drain and reconstruction

What `session.report()` does, step by step:

```
   session.report({ since, flush })
            │
            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 1. for each page in context:                            │
   │      raw = await page.evaluate(({name,s}) =>            │
   │             window[name].drain(s),                      │
   │           { name: channelName, s: cursor })             │
   │      accumulate raw events                              │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 2. for each event with scriptUrl:                       │
   │      sha = urlToSha.get(scriptUrl)                      │
   │      event.scriptSha256 = sha ?? null                   │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 3. partition events by kind:                            │
   │      accessEvents, sinkEvents, hazardEvents             │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 4. reconstruct:                                          │
   │      accessEvents → RawAccess[]                          │
   │      sinkEvents   → NetworkSink[]                        │
   │      hazardEvents → DynamicHazard[]                      │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 5. matchAccesses(rawAccesses, ALL_APIS)                  │
   │      → runtimeFindings                                   │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 6. for each captured script (network + inline + eval):   │
   │      analyze(source) → staticReport                      │
   │      bundle into ScriptAnalysis{                         │
   │        sha256, bytes, acquisition, staticReport,         │
   │        eventRange: [startSeq, endSeq]                    │
   │      }                                                   │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 7. merge(staticFindings, runtimeFindings)               │
   │      → AnnotatedFinding[] with provenance               │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
   ┌─────────────────────────────────────────────────────────┐
   │ 8. compute summary:                                      │
   │      runtimeOnlyKeys = runtime keys \ static keys        │
   │      staticOnlyKeys  = static keys \ runtime keys        │
   │      totalAccesses, sinkCount, leakedApiCount, etc.      │
   └────────────────────────┬────────────────────────────────┘
                            │
                            ▼
                      RuntimeReport
                       (reportVersion: "1.0.0",
                        catalogVersion: "...",
                        trapScriptSha256: "...")
```

Step 5 and step 6 can run in parallel — they're independent. Step 7
joins them.

---

## 7. Static + runtime merge

How `merge(staticFindings, runtimeFindings) → AnnotatedFinding[]`
works:

```
   staticFindings              runtimeFindings
   ─────────────              ──────────────
   key="navigator.userAgent"   key="navigator.userAgent"
     count: 3                    count: 8 (8 fires across run)
     hits: [r1,r2,r3]            hits: [r4..r11]
                                    │
   key="navigator.brave"           │
     count: 1                       │
     hits: [r12]                   │
                                key="navigator.webdriver"
                                  count: 5
                                  hits: [r13..r17]

                  ▼               ▼
            ┌────────────────────────────┐
            │ groupBy api.key            │
            └─────────────┬──────────────┘
                          │
                          ▼
            ┌────────────────────────────────────────────┐
            │ for each key:                              │
            │   sInfo = staticFindings.get(key)          │
            │   rInfo = runtimeFindings.get(key)         │
            │                                            │
            │   if (sInfo && rInfo):                     │
            │     provenance = "static+runtime"          │
            │     count = sInfo.count + rInfo.count      │
            │     hits = sInfo.hits ∪ rInfo.hits         │
            │     callSites = uniq(rInfo.hits.stack)     │
            │   elif sInfo:                              │
            │     provenance = "static"                  │
            │   elif rInfo:                              │
            │     provenance = "runtime"                 │
            │     callSites = uniq(rInfo.hits.stack)     │
            └─────────────┬──────────────────────────────┘
                          │
                          ▼
                 AnnotatedFinding[]

   ──────────────────────────────────────────────────────────
   key                          provenance      callSites
   ──────────────────────────────────────────────────────────
   navigator.userAgent          static+runtime  3
   navigator.brave              static          —
   navigator.webdriver          runtime         5
   ──────────────────────────────────────────────────────────
```

The `runtime`-only row is the eval-blob delta — surfaces the runtime
saw but the source-code static pass missed.

The `static`-only row is the dead-code delta — surfaces declared in
the source but never executed under the conditions of this run.

---

## 8. eval recursion

How `eval("var x = navigator.webdriver;")` becomes a `ScriptAnalysis`
with `acquisition: "eval"`:

```
   page calls eval("var x = navigator.webdriver;")
            │
            ▼
   our eval wrapper fires
            │
            ├─ events.push({
            │    kind: "hazard",
            │    hazardKind: "eval",
            │    source: "var x = navigator.webdriver;",
            │    seq: 800,
            │  })
            │
            ▼
   delegate to the real eval
            │
            ▼
   inside the eval'd code, navigator.webdriver is read
            │
            ▼
   the SAME proxy/wrappers fire (they're installed on globals,
   not on lexical scope)
            │
            ├─ events.push({
            │    kind: "access",
            │    chain: ["navigator", "webdriver"],
            │    seq: 801,
            │    stack: includes the eval call site,
            │  })

   ... eval returns ...

   later: session.report()
            │
            ▼
   driver sees hazard event 800
            │
            ▼
   driver computes sha256 of the captured source string
            │
            ▼
   driver runs analyze(source, { name: "eval-from-<host>-<sha-prefix>.js" })
            │
            ▼
   bundle into ScriptAnalysis with acquisition: "eval", sha256: ...
            │
            ▼
   per-script artifact written to disk:
     runs/<runId>/scripts/<sha>_eval-from-<host>.js
     runs/<runId>/scripts/<sha>_eval-from-<host>.js.report.txt
            │
            ▼
   runtime findings include access events 801..N attributed to this script
   static findings include analyze() findings on the eval'd source
            │
            ▼
   merge tags them static+runtime (both saw it) — but the "static"
   half here is itself a runtime-derived static pass
```

The recursion guard caps depth at 10 — eval-inside-eval-inside-eval
gets traced, eval bombs don't. Cap is in the trap script via a
private `evalDepth` counter inside the trap closure (not exposed on
the channel).

---

## 9. Per-script bundle

What lands on disk at the end of a dynamic run:

```
runs/2026-05-13T15-30-00-000Z/
  manifest.json                  ← run metadata + script index
  summary.txt                    ← headline human report
  report.json                    ← full RuntimeReport JSON
  report.txt                     ← full human-readable report
  network.jsonl                  ← every request + response metadata
  console.log                    ← page console + pageerror events
  page.html                      ← rendered HTML of main frame
  scripts/
    <sha256-12>_<safe-url>.js                ← captured script source
    <sha256-12>_<safe-url>.js.report.json    ← script2builtins JSON report
    <sha256-12>_<safe-url>.js.report.txt     ← script2builtins text report
    ...
  request-bodies/
    <safe-url>.txt               ← POST/PUT bodies
  evals/
    <sha256-12>_eval-from-<host>.js          ← captured eval source
    <sha256-12>_eval-from-<host>.js.report.json
    <sha256-12>_eval-from-<host>.js.report.txt
    ...
```

Filenames lead with the first 12 chars of the sha256 hash so:

- Re-running against an unchanged target produces identical filenames
  (cache-friendly).
- Diffing two runs is as simple as comparing the `scripts/` directories.
- A grep for a script by URL substring still works.

The `manifest.json` is the index — it contains the runId, timing,
target, every captured script's full URL, sha256, byte size,
acquisition kind, and the on-disk path. Tooling around a run reads
the manifest, not the directory listing.

---

## What's NOT in this diagram set

- **Inside the matcher.** `matchAccesses` is documented in
  `script2builtins` (the static package) and unchanged here.
- **The trap script source itself.** It's auto-generated by
  `buildTrapScript()`. The structure is in [Trap
  internals](trap-internals.html); the generated string is dumped
  on demand via `s2b --dump-trap`.
- **Browser-side debugging.** When a trap firing is wrong, the
  `--verbose` flag opens a debug channel that forwards in-page
  `console.debug` lines to Node stderr — useful for "why isn't this
  access showing up" investigations.
