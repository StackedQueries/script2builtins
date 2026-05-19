---
title: Payload tracer
nav_order: 4
---

# Payload tracer

`scanSinks` finds every outbound network sink the script can reach;
the payload tracer turns each sink's body argument into a structured
`PayloadInfo` so you can answer the next question: *which catalog
APIs flow into the bytes that hit the wire?*

This page documents the tracer in enough detail that you can extend
it, audit it, or port the technique to a different AST host.

## What `PayloadInfo` is

The end of every sink-with-body call. Lives in
[`src/types.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/types.ts):

```ts
interface PayloadInfo {
  shape:
    | "json"             // JSON.stringify(<tracked>)
    | "object"           // raw object literal
    | "string"           // single chain or literal body
    | "formdata"         // FormData accumulator
    | "urlsearchparams"  // URLSearchParams instance
    | "blob"             // not-yet-implemented body kinds
    | "url-query"        // URL query string parsed as payload
    | "unknown";         // couldn't statically resolve
  entries: PayloadEntry[];
  leakedApis: ApiDefinition[];
  snippet: string;
}

interface PayloadEntry {
  key: string;
  sourceChain: (string | null)[] | null;   // resolved property chain
  leakedApi?: ApiDefinition;               // catalog match on sourceChain
  literalValue?: string | number | boolean | null;
  snippet: string;
}
```

A `PayloadEntry` is one key/value pair. The value is either a
**resolved chain** (typically a fingerprint surface, e.g.
`["navigator","userAgent"]`) or a **literal**. When `sourceChain`
matches a catalog entry, `leakedApi` is populated. The sink-level
`leakedApis` is the deduplicated union of every matched
`leakedApi` across entries.

## What the tracer covers

| Source pattern                                                    | Result                                                       |
|-------------------------------------------------------------------|--------------------------------------------------------------|
| `fetch(u, { body: "literal" })`                                   | `shape:"string"`, one entry with `literalValue`              |
| `fetch(u, { body: navigator.userAgent })`                         | `shape:"string"`, one entry with `sourceChain` + `leakedApi` |
| `fetch(u, { body: JSON.stringify({ ua: navigator.userAgent }) })` | `shape:"json"`, one entry `ua → navigator.userAgent`         |
| `var d = { ua: navigator.userAgent }; fetch(u, { body: JSON.stringify(d) })` | same — variable origin tracked                    |
| `var d = {}; d.ua = navigator.userAgent; fetch(u, …d…)`           | same — `obj.key = val` accumulates onto the origin           |
| `var f = new FormData(); f.append("ua", navigator.userAgent)`     | `shape:"formdata"`, one entry per `.append`/`.set`           |
| `new URLSearchParams({ ua: navigator.userAgent })`                | `shape:"urlsearchparams"`, object init                       |
| `new URLSearchParams("ua=" + navigator.userAgent)`                | string init — leaks under literal-string fallback            |
| `new URLSearchParams([["ua", navigator.userAgent]])`              | array-of-pairs init                                          |
| `{ ...{ a: navigator.x }, b: y }`                                 | object-spread of inline literal — `a` flattens in            |
| `{ ...captured, b: y }`                                           | identifier-spread — recorded with `refName` marker           |
| `img.src = "https://x/?ua=" + navigator.userAgent`                | `shape:"url-query"` if right-hand side resolves              |
| `location.assign("/r?k=" + v)`                                    | URL query parsed when resolvable                             |

The tracer follows aliases. `var n = navigator; fetch(u, { body: n.userAgent })`
reports the body as `navigator.userAgent`, not `n.userAgent`.

## The two-pass `buildValues` model

[`src/analyze/values.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/analyze/values.ts)
maintains `ValueMap.origins: Map<string, ValueOrigin>`. A `ValueOrigin`
is one of:

```ts
| { kind: "object-literal";  entries: ValueEntry[]; rawSnippet }
| { kind: "chain";           chain: string[];      rawSnippet }
| { kind: "literal";         value: string|number|boolean|null }
| { kind: "formdata";        appends: ValueEntry[] }
| { kind: "urlsearchparams"; appends: ValueEntry[] }
| { kind: "json-stringify";  argName?, argOrigin?, rawSnippet }
| { kind: "unknown";         rawSnippet }
```

Two passes:

1. **First pass** — every `VariableDeclarator` and bare
   `AssignmentExpression` to an identifier seeds `origins`. The
   `init` (or RHS) is passed to `classifyValue`, which decides which
   origin shape to record. First-write-wins.
2. **Second pass** — mutating method calls and property writes
   *augment* existing origins:
   - `f.append("k", v)` / `f.set("k", v)` on a tracked `formdata` /
     `urlsearchparams` pushes a new entry into `appends`.
   - `obj.k = v` / `obj["k"] = v` on a tracked `object-literal`
     pushes a new entry into `entries`.

Two passes (not one) because the second pass needs the binding map
the first pass populates — `f.append(...)` only matters if we know
`f` is a `FormData`.

## `classifyValue` decision tree

Given an arbitrary expression, return a `ValueOrigin` (or `null` for
expressions we don't track):

```
   ┌──────────────────────────────────────────────────────────────┐
   │ resolveStaticString(node) ≠ null                              │
   │   → { kind: "literal", value: <string> }                      │
   │                                                               │
   │ node is Literal (number/boolean/null)                         │
   │   → { kind: "literal", value: <primitive> }                   │
   │                                                               │
   │ node is ObjectExpression                                      │
   │   for each Property:                                          │
   │     entryFromValueExpr(key, value)                            │
   │   for each SpreadElement of inline ObjectExpression:          │
   │     recurse, flatten entries in                               │
   │   for each SpreadElement of Identifier `x`:                   │
   │     entries.push({ key: "...x", refName: "x" })  ← marker     │
   │   → { kind: "object-literal", entries }                       │
   │                                                               │
   │ resolveChain(node) → string[] (and length > 0)                │
   │   → { kind: "chain", chain }                                  │
   │                                                               │
   │ node is NewExpression FormData                                │
   │   → { kind: "formdata", appends: [] }                         │
   │                                                               │
   │ node is NewExpression URLSearchParams(init)                   │
   │   init is ObjectExpression           → entries from props     │
   │   init is ArrayExpression of pairs   → entries from [k, v]    │
   │   init is static string "k=v&k=v"    → entries from split     │
   │   → { kind: "urlsearchparams", appends }                      │
   │                                                               │
   │ node is JSON.stringify(arg)                                   │
   │   argName  = arg.name (when Identifier)                       │
   │   argOrigin = classifyValue(arg)                              │
   │   → { kind: "json-stringify", argName?, argOrigin? }          │
   │                                                               │
   │ otherwise                                                     │
   │   → null   (unknown — sink reports shape "unknown")           │
   └──────────────────────────────────────────────────────────────┘
```

`entryFromValueExpr` turns a `(key, valueNode)` pair into a
`ValueEntry`:

- value resolves to a static string → `{ literalValue }`
- value is a primitive literal → `{ literalValue }`
- value resolves to a chain → `{ chain, refName? }`
- value is a bare identifier with no chain resolution → `{ refName }`
  (so the downstream resolver can chase it via `origins.get`)
- else → `{ key, snippet }` (no value info, just the snippet)

## `tracePayload` — from sink to `PayloadInfo`

`scanSinks` calls `tracePayload(bodyNode, aliases, values, opts)`
for every sink that has a body. The function classifies the body
expression and converts the result into a `PayloadInfo`:

```
   tracePayload(node)
   ┌─────────────────────────────────────────────────────────────┐
   │  1. resolveStaticString(node) ≠ null                         │
   │       → shape "string", one entry { literalValue }            │
   │                                                              │
   │  2. node is Identifier                                       │
   │       origin = values.origins.get(node.name)                 │
   │       payloadFromOrigin(origin)                              │
   │                                                              │
   │  3. inline classification                                    │
   │       origin = classifyValue(node)                           │
   │       payloadFromOrigin(origin)                              │
   │                                                              │
   │  4. else                                                     │
   │       shape "unknown", no entries                            │
   └─────────────────────────────────────────────────────────────┘

   payloadFromOrigin(origin)
   ┌─────────────────────────────────────────────────────────────┐
   │  "object-literal"   → shape "object",   entries from origin  │
   │  "formdata"         → shape "formdata", entries from appends │
   │  "urlsearchparams"  → shape "urlsearchparams"                │
   │  "literal"          → shape "string", one <body> entry       │
   │  "chain"            → shape "string", one <body> entry       │
   │                       with sourceChain                       │
   │  "json-stringify"   → recurse on argOrigin / argName,        │
   │                       force shape "json"                      │
   │  "unknown"          → shape "unknown"                        │
   └─────────────────────────────────────────────────────────────┘
```

`entryToPayloadEntry` is the per-entry converter that follows a
tracked `refName` (the `{ ...captured }` spread marker) to its
origin and copies the resolved chain / literal up:

```
   if entry.literalValue   → emit literal entry
   if entry.chain          → emit chain entry
   if entry.refName        → look up origins.get(refName)
                              if "chain"   → emit chain entry
                              if "literal" → emit literal entry
   else                    → emit entry with no value info
```

## Catalog matching for entries

After `scanSinks` collects all sinks, every payload runs through:

```ts
for (const sink of sinks) {
  if (sink.payload) {
    sink.payload.leakedApis = uniqueApis(
      matchEntriesToApis(sink.payload.entries, opts.apis),
    );
  }
}
```

`matchEntriesToApis` walks each entry, runs `matchChainToApi` on its
`sourceChain` (after global-head stripping), and when a match wins
the entry's `leakedApi` is filled in. The sink-level `leakedApis`
is the deduplicated set.

Two matching shapes, same as `matchAccesses`:

- **Prefix match.** `["navigator", "userAgent"]` matches catalog
  key `"navigator.userAgent"`.
- **Suffix match.** `["form", "userAgent"]` matches catalog key
  `"*.userAgent"` — but the static catalog rarely uses bare
  wildcards on payload-shaped names, so this is mostly used by the
  runtime path (see [`parseRuntimeBody`](#parseruntimebody) below).

## URL-query payloads

When a sink takes a URL with a `?key=value&…` query string, the
tracer surfaces those as literal entries via `maybeQueryStringPayload`:

```ts
img.src = "https://collector.example/p?ua=Mozilla/5.0&fp=abc123";
```

```
   maybeQueryStringPayload(node)
   ┌──────────────────────────────────────────────────┐
   │  url = resolveStaticString(node)                 │
   │  url.split("?")[1].split("&"):                   │
   │    "ua=Mozilla/5.0"                              │
   │    "fp=abc123"                                   │
   │  decodeURIComponent each k=v (with safeDecode    │
   │  fallback for malformed escapes)                 │
   │                                                  │
   │  shape: "url-query"                              │
   │  entries: [                                       │
   │    { key: "ua", literalValue: "Mozilla/5.0", … },│
   │    { key: "fp", literalValue: "abc123",      … }│
   │  ]                                               │
   └──────────────────────────────────────────────────┘
```

`safeDecode` wraps `decodeURIComponent` in a try/catch — a malformed
percent escape used to throw `URIError` and abort analysis of the
whole script. Now a bad query string degrades to the raw bytes for
that one entry.

Template-literal substitution (`` `…?ua=${navigator.userAgent}` ``)
isn't resolved into the query yet — the URL goes in as `null` with
a `urlSnippet`, and the sink reports `payload: null`. That's a known
gap.

## `parseRuntimeBody` — the runtime seam

`script2builtins-runtime` traps request bodies at send-time and
captures them as a serialized preview. To feed those through the
same catalog matcher the AST path uses,
[`parseRuntimeBody`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins/src/analyze/sinks.ts)
takes a `RuntimeBody` and produces the same `PayloadInfo` shape:

```ts
import { parseRuntimeBody } from "script2builtins/analyze";
import { ALL_APIS } from "script2builtins-knowledge";

const payload = parseRuntimeBody(
  { shape: "json", preview: '{"userAgent":"…","webdriver":true}', truncated: false },
  ALL_APIS,
);
// → payload.leakedApis = [ {key: "navigator.userAgent"}, {key: "navigator.webdriver"} ]
```

Shape handling:

| shape              | how it's decoded                                                  |
|--------------------|-------------------------------------------------------------------|
| `"empty"`          | no entries                                                        |
| `"blob"`           | no entries (opaque)                                               |
| `"binary"`         | no entries (opaque; surfaced as `"unknown"` shape downstream)     |
| `"urlsearchparams"`| split `k=v&k=v`, decode each                                      |
| `"formdata"`       | JSON-decode the `[[k,v], …]` pair array the trap emits            |
| `"json"`           | `JSON.parse` then flatten one level (depth ≤ 3, dot-joined keys)  |
| `"string"`         | try JSON first; fall back to urlencoded if `k=v&k=v`; else opaque |

Two-stage match: a multi-segment chain (`["screen","width"]` from
nested JSON) tries a direct prefix match first so the canonical
catalog entry wins. Single-segment chains skip the direct path —
it would otherwise match a bare-global entry (`webdriver`) ahead of
the canonical `navigator.webdriver`. The tail-name matcher
(`matchByLeafName`) is the fallback with explicit tiers:

- Tier 1: concrete length-2 (`navigator.platform`)  ← canonical
- Tier 2: concrete length ≥ 3 (`navigator.userAgentData.platform`)
- Tier 3: wildcard (`*.platform`)
- Tier 4: bare global (`platform`)

`__proto__`-containing keys are dropped at the gate — they describe an
introspection path, not a payload target.

This is the same matcher the AST path uses, so a runtime sink and a
static sink with the same body shape produce identical `leakedApis`.

## What the tracer still misses

These are deliberate gaps — the cost/value didn't pencil out yet:

- **Template-literal URLs.** `` `https://x?ua=${navigator.userAgent}` ``
  doesn't resolve through `resolveStaticString` because expressions
  are non-empty. The sink is still emitted with a `urlSnippet` but
  the query isn't expanded.
- **Conditional / ternary values.** `{ ua: cond ? a.b : c.d }` —
  `classifyValue` returns null on `ConditionalExpression`. Reported
  as `snippet` only, no `sourceChain`.
- **Reassignment.** `var d = { a: navigator.x }; d = { b: navigator.y };
  fetch(u, { body: JSON.stringify(d) })` — only the first binding is
  tracked. The body is reported as `a → navigator.x`, not `b → navigator.y`.
- **Array values.** `{ ua: [navigator.userAgent, navigator.language] }` —
  array literals aren't classified. The entry's value is recorded as
  a snippet but `sourceChain` is null. (Fixable; not yet done.)
- **Cross-function flow.** Values that travel through a function
  return aren't traced. `function wrap(x) { return { ua: x }; }; fetch(u, JSON.stringify(wrap(navigator.userAgent)))`
  — the wrapper hides the chain. This needs proper data-flow, which
  is out of scope for a forensic tool.

For each of these, the runtime tracer ([`parseRuntimeBody`](#parseruntimebody))
catches it: by the time the body is on the wire, every chain has
been resolved to its literal value, and the catalog match runs on
the keys.

## Reading the rendered output

The renderer prints each sink with its payload:

```
network sinks (2)
  fetch            18:5  POST https://collector.example/c
    headers: Content-Type: application/json
    payload: json (3 fingerprint APIs exfiltrated)
      · ua                   = navigator.userAgent [navigator]
      · webdriver            = navigator.webdriver [navigator]
      · canvas               = "data:image/png;base64,…"
      · plugins              = navigator.plugins [navigator]

  image-src        42:3  GET https://collector.example/p?fp=…
    payload: url-query
      · fp                   = "abc123"
```

The `[category]` suffix on a catalog match makes it easy to spot
which fingerprint axis is leaving in which field. The summary at
the top of the report deduplicates: `fingerprints exfiltrated` is
the size of the union across all sinks.

## Compose your own

The tracer is exported. You can swap the catalog, skip `scanSinks`,
or trace a body node directly:

```ts
import { parse } from "script2builtins/analyze";
import { walkProgram } from "script2builtins/analyze";
import {
  buildAliases,
  buildValues,
  tracePayload,
} from "script2builtins/analyze";
import { ALL_APIS, watchedRoots } from "script2builtins-knowledge";

const { program } = parse(source);
const aliases = buildAliases(program!);
const values = buildValues(program!, aliases, source);

// Find a specific body expression in the AST and trace it:
const payload = tracePayload(bodyNode, aliases, values, {
  source, apis: ALL_APIS,
});
console.log(payload.shape, payload.entries.length);
```

`tracePayload` and `parseRuntimeBody` are the two seams `script2builtins-runtime`
hooks into. The static catalog stays the single source of truth for
"what counts as a fingerprint surface."
