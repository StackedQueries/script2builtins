---
title: Architecture
nav_order: 2
---

# Architecture

The pipeline has four moving parts plus a catalog. Each part has one
job and the seam between them is a typed intermediate structure —
`Program` → `RawAccess[]` → `Finding[]` → `NetworkSink[]` → `Report`.

```
   ┌──────────────────┐
   │  source string   │  CLI flag / library arg / stdin
   └────────┬─────────┘
            │
            ▼
   ┌──────────────────┐
   │  parse           │  acorn, module-then-script fallback
   │  (parse.ts)      │
   └────────┬─────────┘
            │  Program | null
            ▼
   ┌──────────────────┐    ┌──────────────────────────┐
   │  buildAliases    │───▶│  AliasMap                │
   │  (aliases.ts)    │    │  { chains, strings }     │
   └────────┬─────────┘    └──────────┬───────────────┘
            │                         │
            ▼                         ▼
   ┌──────────────────┐    ┌──────────────────────────┐
   │  walkProgram     │    │  buildValues             │
   │  (walk.ts)       │    │  (values.ts)             │
   │                  │    │                          │
   │  - MemberExpr    │    │  - object literals       │
   │  - Identifier    │    │  - JSON.stringify(x)     │
   │  - CallExpr      │    │  - FormData accumulator  │
   │  - WithStmt      │    │  - URLSearchParams init  │
   │  - ImportExpr    │    └──────────┬───────────────┘
   └────────┬─────────┘               │
            │                         │
            │  RawAccess[]            │  ValueMap
            │  DynamicHazard[]        │
            ▼                         ▼
   ┌──────────────────┐    ┌──────────────────────────┐
   │  matchAccesses   │    │  scanSinks               │
   │  (match.ts)      │    │  (sinks.ts)              │
   │                  │    │                          │
   │  chain + arg →   │    │  fetch / XHR / WS /      │
   │  ApiDefinition   │    │  sendBeacon / *.src /    │
   │                  │    │  Worker / location / …   │
   └────────┬─────────┘    └──────────┬───────────────┘
            │                         │
            │  Finding[]              │  NetworkSink[]
            │  unknown:               │  payload.entries[]
            │  RawAccess[]            │  .leakedApi (cataloged)
            ▼                         ▼
   ┌────────────────────────────────────────────────┐
   │                  analyze()                     │
   │  (src/index.ts)                                │
   │                                                │
   │  groupByCategory + computeSummary              │
   └────────────────────┬───────────────────────────┘
                        │
                        ▼
                  Report (JSON-serializable)
                        │
                        ▼
            ┌──────────────────────┐
            │  renderText          │  optional human report
            │  (report/text.ts)    │
            └──────────────────────┘
```

The catalog (the sibling `script2builtins-knowledge` package — one
file per category under `packages/script2builtins-knowledge/src/`) is
consumed twice — once by `watchedRoots()` so the walker knows which
bare identifiers to record, and once by `matchAccesses` and
`scanSinks` to resolve a chain back to an `ApiDefinition`. It's not a
stage; it's the spec.

## Parser

[`src/analyze/parse.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/analyze/parse.ts)
wraps `acorn.Parser.parse` with a permissive option set
(`allowReturnOutsideFunction`, `allowAwaitOutsideFunction`,
`allowImportExportEverywhere`, `allowHashBang`, `ecmaVersion: "latest"`)
and tries `module` first then falls back to `script` on syntax error.

Why both: detector blobs are usually IIFEs (script) but `import` /
top-level `await` show up in newer SDKs. We want to accept either
without making the caller declare which it is. The forced
`sourceType` option exists for callers who already know.

A parse failure does not throw. It returns `program: null` with a
populated `errors` list in `ParseInfo`. Downstream stages no-op on a
null program; `analyze` returns an empty report that records the
parse failure. The CLI exits with code 1 on parse failure for clean
shell composition.

## Walker

[`src/analyze/walk.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/analyze/walk.ts)
runs one ancestor-aware walk that:

1. **Member expressions** — extracts the dot-chain from any
   `MemberExpression` whose parent is not also a member with this
   node as its `.object`. That last clause prevents emitting
   `["a", "b"]` and `["a", "b", "c"]` for the same `a.b.c` chain;
   only the outermost emits the full chain.
2. **Identifiers** — emits a one-segment access for any reference
   identifier whose name is in `watchedRoots()`. This is how bare
   `navigator` (no member after it — `navigator` passed as an arg,
   for instance) still shows up.
3. **Calls and `new` expressions** — collects dynamic-execution
   hazards (`eval(...)`, `Function(...)` / `new Function`,
   string-form `setTimeout` / `setInterval`, `document.write[ln]`).
4. **`with` statements and `import()` expressions** — recorded as
   hazards. Both put code or scope beyond static reach.

The walker uses `acorn-walk`'s ancestor mode so it can decide whether
an identifier appears in a binding position vs a reference position
without re-walking. The `isReferenceIdentifier` switch (`walk.ts:127`)
covers the dozen-or-so AST contexts where an `Identifier` node is
*not* a reference: declaration names, function parameters, non-shorthand
property keys, `import` / `export` specifiers, labels, etc.

For each member chain the walker calls `extractMemberChain`, which
walks from the leaf back through `.object` segments, resolving each
property through `resolveProperty` (handles computed-string keys,
template literals with no expressions, and string aliases) and
following the head identifier through `AliasMap.chains` if it's
bound to a known global chain. Global heads (`window`, `self`,
`globalThis`, `top`, `parent`, `frames`) are then stripped so
`window.navigator.x` and `navigator.x` collapse to one shape.

## Alias and string resolution

[`src/analyze/aliases.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/analyze/aliases.ts)
builds two maps:

- `chains: Map<localName, globalChain>` — e.g.
  `{ "n": ["navigator"], "p": ["navigator", "plugins"] }`
- `strings: Map<localName, stringValue>` — e.g.
  `{ "k": "userAgent" }`

Built in two passes over all `VariableDeclarator` nodes so a chain
that references another alias resolves on the second pass
(`var n = navigator; var p = n.plugins`).

The model is deliberately conservative — first-binding-wins,
reassignments ignored. This is a forensic heuristic, not a sound
data-flow analysis. The cost of a false positive (we report a
surface the script doesn't actually touch) is a re-read of the
snippet evidence; the cost of a false negative (a surface goes
unreported) is the user assumes a detector is simpler than it is.
We bias toward the former.

## Matcher

[`src/analyze/match.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/analyze/match.ts)
is a small ~100-line module. For each `RawAccess` it walks the
compiled catalog and emits a `Finding` for every entry whose key
shape matches.

Two key shapes:

- `"navigator.userAgent"` — chain (after global-root stripping)
  starts with this. Exact prefix match.
- `"*.toDataURL"` — chain ends with this suffix, root is irrelevant.
  Used for prototype-side methods (`canvas.toDataURL`,
  `offscreenCanvas.toDataURL`, etc.) where the root identifier name
  is whatever local the script uses for the element.

An access can satisfy multiple entries (a `Function.prototype.toString`
read also matches `*.toString`); the matcher keeps all matches so
the report shows every applicable interpretation. The merged result
is sorted by severity (high → info), then category, then key.

`argMatch` filters apply on top: if `api.argMatch` is set, the access
only matches when `access.called` is true and `firstStringArg`
equals one of the listed strings. This is how `getContext("2d")`,
`getContext("webgl")`, and `getContext("webgpu")` route to
different catalog entries.

## Sink scanner

[`src/analyze/sinks.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/analyze/sinks.ts)
is the largest module. Two passes:

1. **First pass** discovers `XMLHttpRequest`-like and `WebSocket`
   instances and seeds per-variable state tables
   (`xhrInstances`, `wsInstances`).
2. **Second pass** walks every `CallExpression`, `NewExpression`,
   and `AssignmentExpression` for sink patterns:

   - `fetch(url, init)` — extracts method, headers, and body from
     the init object literal.
   - `xhr.open` / `xhr.setRequestHeader` / `xhr.send` on a tracked
     instance — accumulates state then emits one `xhr` sink per
     `send` call with the resolved method, URL, headers, and body.
   - `navigator.sendBeacon(url, body)` — single sink with method `POST`.
   - `new WebSocket(url)` → `websocket-open` sink; `ws.send(body)`
     → `websocket-send` sink that references the tracked URL.
   - `new EventSource(url)`, `new Worker(url)`, `new SharedWorker(url)`,
     `navigator.serviceWorker.register(url)` — URL-only sinks.
   - `importScripts(url, …)` — one sink per URL argument.
   - `<elt>.src = url` — `image-src` or `script-src` based on a
     heuristic on the `createElement` chain.
   - `location.href = url`, `location.assign(url)`,
     `location.replace(url)`, `window.location = url` —
     `navigation` sinks; URL query string parsed as payload.

For sinks with bodies, the body argument runs through `tracePayload`
(see [Payload tracer](payload-tracer.html)). Each entry is then
matched to the catalog by chain, and the union of matches becomes
the sink's `leakedApis` set.

## Report shape

`analyze()` returns one `Report`:

```ts
{
  source: { name, bytes, lines },
  parse:  { ok, sourceType, errors },
  findings: Finding[],                // sorted by severity
  byCategory: Record<string, Finding[]>,
  hazards: DynamicHazard[],
  networkSinks: NetworkSink[],
  unknownAccesses: RawAccess[],       // empty unless includeUnknown
  summary: {
    totalAccesses,
    knownAccesses,
    botDetectionTells,
    fingerprintingDensityPerKb,
    categories: string[],
    sinkCount,
    leakedApiCount,
  },
}
```

Full types live in
[`src/types.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/types.ts).
The shape is a strict subset of `script2builtins-runtime`'s
`RuntimeReport`, so the two are composable downstream — the runtime
report tags each finding with `provenance` and adds a few summary
fields, but every field in `Report` is present.

## Renderer

[`src/report/text.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/report/text.ts)
takes a `Report` and produces a human-readable string. It's a pure
formatter — no analysis logic. Filter / cap / colour decisions live
here (`minSeverity`, `categories`, `showHits`, `maxHitsPerFinding`,
`noColor`). The CLI is a thin wrapper that parses argv and pipes the
output to stdout.

JSON output skips the renderer entirely: `analyze()` returns a
JSON-serializable object, the CLI calls `JSON.stringify(report, null, 2)`.

## Where things live in the repo

```
packages/script2builtins/
  src/
    cli.ts                 # argv parsing + stdin handling
    index.ts               # analyze() — top-level orchestrator
    types.ts               # every public type
    analyze/
      parse.ts             # acorn wrapper
      walk.ts              # accesses + hazards + alias seeding
      aliases.ts           # AliasMap + resolveChain / resolveStaticString
      values.ts            # ValueMap for payload tracing
      match.ts             # RawAccess → Finding
      sinks.ts             # NetworkSink + tracePayload + parseRuntimeBody
      structural.ts        # consistency-check + high-res-timer detectors
      vm-detector.ts       # VM/bytecode signature detector
      honeypots.ts         # cognitive-honeypot detector
      favicons.ts          # favicon cache-probe detector
      util.ts              # shared helpers
      index.ts             # subpath barrel
    report/
      text.ts              # renderText()
  test/                    # vitest fixtures + unit tests
  examples/
    canvas-fingerprint.js  # canvas-only detector
    exfiltration.js        # sink + payload tracing
    headless-tells.js      # webdriver / phantom / pwInitScripts
    obfuscated.js          # alias + string-concat dynamic keys
    programmatic.mjs       # library usage
  docs/                    # this site

packages/script2builtins-knowledge/
  src/
    index.ts               # ALL_APIS + watchedRoots
    navigator.ts           # ~50 entries
    canvas.ts              # ~30 entries
    webgl.ts               # ~30 entries
    headless-tells.ts      # ~50 entries
    introspection.ts       # ~30 entries
    …                      # 18 more category files
```

## Two facts worth pinning down

1. **`watchedRoots()` is the bridge between the walker and the
   catalog.** It returns the set of every leftmost identifier that
   appears in `ALL_APIS` (skipping wildcard `*` keys), plus a fixed
   set of hazard call targets (`eval`, `Function`, …) and
   always-watched globals (`navigator`, `document`, `window`,
   `screen`, …). The walker uses it to decide whether a bare
   identifier reference is worth emitting an access for. Adding a
   new root API key automatically extends this set.
2. **The same matcher is used by `script2builtins-runtime`.** The
   runtime package converts in-page Proxy / wrapper events into
   `RawAccess[]` and feeds them to `matchAccesses`. One catalog, one
   matcher, two event sources. See `script2builtins-runtime`'s
   [architecture page](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins-runtime/docs/architecture.md)
   for how the runtime side wires up.
