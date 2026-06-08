---
title: Analysis flow
nav_order: 3
---

# Analysis flow

Diagrams of how data moves through `analyze()`. Read this alongside
[Architecture](architecture.html) (which describes *what* the parts
are) and [Payload tracer](payload-tracer.html) (which describes
*how* sinks become structured payloads).

---

## Diagram index

1. [CLI dispatch — input shape → analyze](#1-cli-dispatch)
2. [`analyze()` lifecycle — source string to Report](#2-analyze-lifecycle)
3. [Alias resolution — two-pass binding collection](#3-alias-resolution)
4. [Single access — one `navigator.userAgent` from AST to Finding](#4-single-access)
5. [Member chain extraction — collapsing `window.navigator["user"+"Agent"]`](#5-chain-extraction)
6. [Sink discovery — XHR state machine](#6-sink-discovery)
7. [Catalog match — chain + arg → ApiDefinition](#7-catalog-match)
8. [Hazard detection — what falls off the static map](#8-hazard-detection)

---

## 1. CLI dispatch

The `script2builtins` binary routes by input shape before any analysis
runs:

```
┌──────────────────────────────────────────────────────────────────────┐
│              $ script2builtins [flags] [file...] [-]                 │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │  parseArgs(argv)     │
                   │  (src/cli.ts)        │
                   └──────────┬───────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
        files: [..]       fromStdin = true    files: [] & !TTY
            │                 │                 │
            ▼                 ▼                 ▼
       readFile each      readStdin()       readStdin() (implicit)
            │                 │                 │
            └────────┬────────┴────────┬────────┘
                     │                 │
                     ▼                 ▼
              inputs: { name, source }[]
                            │
                            ▼
              analyze(source, { name, sourceType?, includeUnknown }) per input
                            │
                            ▼
            ┌─────────────────────────────────┐
            │  format === "json"?             │
            └───────────┬─────────────────────┘
                        │
              ┌─────────┴─────────┐
            yes                   no
              │                   │
              ▼                   ▼
       JSON.stringify       renderText(report, opts)
       (single or array)    per report, separator
              │                   │
              ▼                   ▼
        stdout              stdout (ANSI by default if TTY)
                                  │
                                  ▼
                          exit 1 on any parse failure, else 0
```

`--sinks-only` and `--no-sinks` are renderer flags — they don't change
what `analyze()` produces. `--include-unknown` is the only flag that
changes report content (it populates `unknownAccesses`).

---

## 2. `analyze()` lifecycle

One function call goes from source string to `Report`. ~30 lines of
orchestration; the work lives in the stage modules.

```
   ┌────────────────────────────────┐
   │  analyze(source, options)      │
   │  (src/index.ts)                │
   └──────────────┬─────────────────┘
                  │
                  ▼
   ┌────────────────────────────────┐
   │  countLines, Buffer.byteLength │
   └──────────────┬─────────────────┘
                  │
                  ▼
   ┌────────────────────────────────┐
   │  parse(source, sourceType?)    │  acorn module-then-script
   │  → { program, info }           │
   └──────────────┬─────────────────┘
                  │
       ┌──────────┴──────────┐
   program == null         program != null
       │                     │
       ▼                     ▼
   empty Report     ┌────────────────────────────────┐
   (parse failure)  │  walkProgram(program, opts)    │
                    │  → { accesses, hazards,        │
                    │       aliases }                │
                    └──────────────┬─────────────────┘
                                   │
                                   ▼
                    ┌────────────────────────────────┐
                    │  matchAccesses(accesses,       │
                    │                ALL_APIS)       │
                    │  → { findings, unknown }       │
                    └──────────────┬─────────────────┘
                                   │
                                   ▼
                    ┌────────────────────────────────┐
                    │  scanSinks(program, aliases,   │
                    │            { source, apis })   │
                    │  → NetworkSink[]               │
                    │     (with .payload.leakedApis) │
                    └──────────────┬─────────────────┘
                                   │
                                   ▼
                    ┌────────────────────────────────┐
                    │  groupByCategory(findings)     │
                    │  computeSummary({findings,     │
                    │                  networkSinks, │
                    │                  bytes})       │
                    └──────────────┬─────────────────┘
                                   │
                                   ▼
                              Report (JSON)
```

`scanSinks` and `matchAccesses` are independent — they both consume
`accesses` / `aliases` but neither feeds the other. They could run in
parallel; today they run sequentially because the overhead doesn't
justify the threading.

---

## 3. Alias resolution

The walker calls `buildAliases(program)` first so chain extraction
can resolve `n.webdriver` back to `["navigator", "webdriver"]`. Two
passes because aliases can chain: `var n = navigator; var p = n.plugins`
needs `n` to be resolved on pass 1 so `p` can be resolved on pass 2.

```
   ┌──────────────────────────────────────────────────────────┐
   │  pass 1:                                                  │
   │    for each VariableDeclarator:                           │
   │      try resolveStaticString(init) → strings.set(name)    │
   │      else resolveChain(init)       → chains.set(name)     │
   │                                                           │
   │  source: var n = navigator;                               │
   │          var k = "user" + "Agent";                        │
   │  result: chains  = { n: ["navigator"] }                   │
   │          strings = { k: "userAgent" }                     │
   └──────────────────────┬───────────────────────────────────┘
                          │
                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  pass 2:                                                  │
   │    resolveChain now sees `n` in chains, so:               │
   │      var p = n.plugins                                    │
   │      → resolveChain looks up n → ["navigator"]            │
   │      → recurses through MemberExpression                  │
   │      → chains.set("p", ["navigator", "plugins"])          │
   │                                                           │
   │    string concat with alias resolves too:                 │
   │      var name = k + "X"  → strings.set("name", "userAgentX")│
   └──────────────────────────────────────────────────────────┘
```

First-binding-wins. Reassignment is ignored:

```js
var n = navigator;        // chains.set("n", ["navigator"])
n = somethingElse;        // ignored (already in map)
n.userAgent;              // still resolves as navigator.userAgent
```

This is a conservative bias — we'd rather over-report a surface than
miss it. See [Limits](limits.html) for the cases where this bites.

---

## 4. Single access

What happens between `navigator.userAgent` in the source and the
`Finding` showing up in the report.

```
   source:                              walker (walk.ts)
   ────────────                         ─────────────────
   navigator.userAgent
        │
        ▼
   AST: MemberExpression {
          object: Identifier "navigator",
          property: Identifier "userAgent",
          computed: false,
        }
        │
        ▼ walkAncestor visits the MemberExpression
        │
        ▼ skip-if-inner check:
        │  parent is not another MemberExpression with us as .object → emit
        │
        ▼ extractMemberChain(member, aliases)
        │  cursor = member
        │   ├─ resolveProperty(cursor) → "userAgent"
        │   └─ cursor = cursor.object = Identifier "navigator"
        │  resolveRoot("navigator", aliases)
        │   ├─ aliases.chains.has("navigator") → no
        │   └─ chain = ["navigator"], aliased = false
        │  parts (leaf → root) = ["userAgent"]
        │  parts.reverse() + root → ["navigator", "userAgent"]
        │  stripGlobalHead → ["navigator", "userAgent"]  (no global head to strip)
        │
        ▼ accesses.push({
        │    chain: ["navigator", "userAgent"],
        │    called: false,
        │    loc: { start: {line, column}, end: {…} },
        │    snippet: "navigator.userAgent",
        │    resolvedThroughObfuscation: false,
        │    hasDynamicSegment: false,
        │    firstStringArg: undefined,
        │  })

                                        matcher (match.ts)
                                        ──────────────────
                                        for each compiled api in ALL_APIS:
                                          chainMatches(access.chain, c) ?
                                            ["navigator","userAgent"] starts with
                                            ["navigator","userAgent"] → yes
                                          argMatches(access, c.api) ?
                                            api.argMatch undefined → yes
                                          buckets.get(api).push(access)

                                        Finding {
                                          api: { key: "navigator.userAgent",
                                                 category: "navigator",
                                                 severity: "low",
                                                 description: "…",
                                                 evasion: "…" },
                                          hits: [access],
                                          count: 1,
                                        }
```

`*.toString` also matches (`["navigator","userAgent"]` ends with
`["toString"]`? no — different chain, doesn't match). The `*` wildcard
is on prototype-side methods (`*.toDataURL`, `*.getContext`, etc.)
and only fires for accesses whose chain ends with the catalog suffix.

---

## 5. Chain extraction

The interesting case is a chain with computed keys and a global head:

```js
window.navigator["user" + "Agent"]
```

```
   AST:  MemberExpression {                              ← outermost
           object: MemberExpression {                    ← middle
             object: Identifier "window",
             property: Identifier "navigator",
             computed: false,
           },
           property: BinaryExpression "+" {              ← computed key
             left:  Literal "user",
             right: Literal "Agent",
           },
           computed: true,
         }

   walker visits outermost first (extractMemberChain):
     cursor = outermost
     ┌─ resolveProperty(outermost):
     │    computed → resolveStaticString(outermost.property, aliases)
     │    BinaryExpression "+" → resolveStaticString(left) + resolveStaticString(right)
     │                         → "user" + "Agent" = "userAgent"
     │    → "userAgent"
     │  cursor.computed = true → resolvedThroughObfuscation = true
     │  parts = ["userAgent"]
     │
     ├─ cursor = outermost.object = middle MemberExpression
     │  resolveProperty(middle) → "navigator"   (not computed)
     │  parts = ["userAgent", "navigator"]
     │
     └─ cursor = middle.object = Identifier "window"
        loop exits
        resolveRoot("window", aliases) → { chain: ["window"], aliased: false }

   parts.reverse() = ["navigator", "userAgent"]
   fullChain      = ["window", "navigator", "userAgent"]
   stripGlobalHead: "window" ∈ GLOBAL_ROOTS, advance → ["navigator", "userAgent"]

   RawAccess {
     chain: ["navigator", "userAgent"],
     called: false,
     resolvedThroughObfuscation: true,    ← computed-key resolution
     hasDynamicSegment: false,
     snippet: 'window.navigator["user" + "Agent"]',
     …
   }
```

Five distinct surfaces collapsed into one canonical chain shape. The
matcher then sees the same `["navigator","userAgent"]` it would see
for the literal source — same `Finding`, same catalog entry.

If `"user" + "Agent"` were replaced with `obfuscate(0x1a3)`,
`resolveStaticString` returns `null`, the property goes in as `null`,
and `hasDynamicSegment` flips to true. The access is emitted but the
matcher won't resolve it. It surfaces in `unknownAccesses` if
`includeUnknown` is set; otherwise the matcher's wildcard rules might
still catch a partial suffix.

---

## 6. Sink discovery

`scanSinks` is two passes because XHR state spans calls:

```
   pass 1: walk all VariableDeclarators
   ┌────────────────────────────────────────────────┐
   │  var x = new XMLHttpRequest()                  │
   │  → xhrInstances.set("x", { method: null,       │
   │                            url: null,          │
   │                            headers: {} })      │
   │                                                │
   │  var ws = new WebSocket("wss://...")           │
   │  → wsInstances.set("ws", { url: "wss://..." }) │
   │  + emit immediately:                           │
   │     sinks.push({ kind: "websocket-open", ... })│
   └──────────────────┬─────────────────────────────┘
                      │
                      ▼
   pass 2: walk all CallExpr / NewExpr / AssignmentExpr
   ┌────────────────────────────────────────────────┐
   │  x.open("POST", "/collect")                    │
   │  → xhrInstances.get("x").method  = "POST"      │
   │  → xhrInstances.get("x").url     = "/collect"  │
   │                                                │
   │  x.setRequestHeader("Content-Type", "json")    │
   │  → xhrInstances.get("x").headers["Content-Type"] = "json"│
   │                                                │
   │  x.send(body)                                  │
   │  → sinks.push({ kind: "xhr",                   │
   │                 method: "POST",                │
   │                 url: "/collect",               │
   │                 headers: { Content-Type: "json" },│
   │                 payload: tracePayload(body, …) })│
   └──────────────────┬─────────────────────────────┘
                      │
                      ▼
   ┌────────────────────────────────────────────────┐
   │  for each sink with payload:                   │
   │    payload.leakedApis = uniqueApis(            │
   │      matchEntriesToApis(payload.entries, ALL_APIS)│
   │    )                                           │
   └────────────────────────────────────────────────┘
```

XHR state is per-variable. If the script does
`new XMLHttpRequest().open(...)` inline (no binding), the state
table never sees it — that's a known limitation. Most detector blobs
bind their XHR to a local so this catches the common case.

`fetch` doesn't need state because everything lives in the single
init-object argument. `sendBeacon` is one call. `WebSocket` /
`EventSource` / `Worker` / `Image.src` follow the variable-bound
pattern only when the body needs reading later.

---

## 7. Catalog match

The matcher is the simplest stage. For each `RawAccess`:

```
   for each compiled api in ALL_APIS:
     ┌─────────────────────────────────────────────────┐
     │ chainMatches?                                   │
     │                                                 │
     │ wildcard:  ["*", "toDataURL"]                   │
     │   → tail = ["toDataURL"]                        │
     │   → access.chain ends with tail?                │
     │                                                 │
     │ non-wildcard: ["navigator", "webdriver"]        │
     │   → access.chain starts with these segments?    │
     └──────────────────┬──────────────────────────────┘
                        │
                        ▼
     ┌─────────────────────────────────────────────────┐
     │ argMatches?                                     │
     │                                                 │
     │ api.argMatch absent → yes (no filter)           │
     │ api.argMatch set    → access.called &&          │
     │                       firstStringArg ∈ argMatch │
     │                                                 │
     │ getContext("2d")   ∈ ["2d"]               → yes │
     │ getContext("webgl")∈ ["2d"]               → no  │
     └──────────────────┬──────────────────────────────┘
                        │
                        ▼
              buckets.get(api).push(access)
              matchedAccesses.add(access)

   for each [api, hits] in buckets:
     findings.push({ api, hits, count: hits.length })

   sort findings:
     by severity rank (high=0, medium=1, low=2, info=3)
     then by category lexicographic
     then by key lexicographic

   unknown = accesses with no match
```

An access can match multiple entries (`navigator.userAgentData.platform`
matches `*.platform` *and* `navigator.userAgentData.platform`). All
matches are kept; the report shows each interpretation.

---

## 8. Hazard detection

Hazards are recorded as a parallel stream — they don't go through
`matchAccesses`. The walker's `CallExpression`, `NewExpression`,
`WithStatement`, and `ImportExpression` visitors emit them directly:

```
   eval(<anything>)             → hazard { kind: "eval" }
   Function(<anything>)         → hazard { kind: "Function" }
   new Function(<anything>)     → hazard { kind: "Function" }
   setTimeout("string", n)      → hazard { kind: "setTimeout-string" }
                                   (only if first arg resolves to a string)
   setInterval("string", n)     → hazard { kind: "setInterval-string" }
   document.write(<anything>)   → hazard { kind: "document-write" }
   document.writeln(<anything>) → hazard { kind: "document-write" }
   with (<obj>) { … }           → hazard { kind: "with-statement" }
   import(<expr>)               → hazard { kind: "import-call" }
```

A hazard means "the static pass cannot follow what happens here."
If the script is heavy on hazards, the report's `findings` list is a
*lower bound* on the surface area — the real detector probably
touches more APIs inside its eval'd payloads. That's the seam where
`script2builtins-runtime` adds the rest.

---

## What's NOT in this diagram set

- **Per-API catalog content.** See [Catalog reference](catalog.html)
  for how `ApiDefinition` entries are written and how categories are
  organized.
- **Payload tracing internals.** Object-literal / `JSON.stringify` /
  `FormData` / `URLSearchParams` walking has its own diagram on
  [Payload tracer](payload-tracer.html).
- **The renderer.** It's a pure formatter — nothing interesting to
  diagram. See `src/report/text.ts`.
