---
title: Design review
nav_order: 8
---

# Design review

This is the design ledger for `script2builtins`. Decisions live here
with their reasoning so a future maintainer can read *why* the code
looks the way it does. New decisions append; existing ones get an
"amended" note rather than being rewritten.

The companion ledger for the dynamic side lives at
[`script2builtins-runtime/docs/design-review.md`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins-runtime/docs/design-review.md).
The two packages share principles 1–4 below verbatim; the rest are
static-pass-specific.

---

## Principles

These are the design rules the codebase tries not to violate. When
two principles disagree, the one nearest the top wins.

1. **The catalog is the spec.** `ALL_APIS` in the sibling
   `script2builtins-knowledge` package is the single source of truth
   for what counts as a fingerprint surface. Adding a surface is a
   one-line PR to a category file there. The walker discovers new
   roots automatically through `watchedRoots()`; the matcher resolves
   them on next run; the runtime package generates traps for them on
   its next build.
2. **One matcher, one catalog.** The same `matchAccesses` resolves
   AST-derived `RawAccess[]` and runtime-derived `RawAccess[]`. The
   shape is identical (`chain`, `called`, `firstStringArg`,
   `hasDynamicSegment`), so the two paths compose without
   translation.
3. **Forensic bias.** When in doubt, over-report. The cost of a
   false positive is one snippet to skip; the cost of a false
   negative is the user assumes the detector is simpler than it is.
   First-binding-wins alias resolution, multi-match findings, and
   wildcard-suffix keys all express this bias.
4. **JSON-serializable everything.** `Report` is a plain object.
   No class instances, no `Date` fields, no functions. The CLI's
   `--json` flag is `JSON.stringify(report, null, 2)` — that's it.
   Downstream tools (and the runtime package's merger) can read
   the shape without bespoke deserialization.
5. **Zero runtime deps beyond a parser.** Just `acorn` and
   `acorn-walk`. Adding a third dep is a `D-`-level decision that
   needs a written justification. This is the cheapest tool in the
   toolchain; it should stay cheap.
6. **The renderer is a pure formatter.** Filter / cap / colour
   decisions live in `src/report/text.ts`; they never affect what
   `analyze()` produces. If a `--no-color` invocation produced a
   different report than a TTY invocation, that would be a bug.

---

## Decisions

### D-1. acorn over Babel / SWC / TypeScript {#d-1}

`acorn` is small (~120 KB), fast, ESM-native, and parses everything
through `ecmaVersion: "latest"` plus the permissive flags. The
alternatives:

- **`@babel/parser`** — bigger, slower, brings the `@babel/types`
  surface as a transitive dep. Wins on JSX / TypeScript / Flow,
  which we don't want to support (D-7).
- **SWC / esbuild parsers** — Rust-bound, faster but the binary
  install story is hostile for an `npm install -g` CLI.
- **TypeScript compiler API** — gigantic, slow, and overkill.

Detector blobs are JS, often minified, sometimes with stage-3
syntax. acorn handles all of it.

### D-2. Module-then-script parse fallback {#d-2}

`parse(source)` tries `sourceType: "module"` first and falls back to
`"script"` on syntax error. Why both: detector code is usually IIFE
(script) but newer SDKs use `import` / top-level `await`. We don't
want callers to declare which.

The `--source-type` CLI flag exists for callers who already know,
and the library accepts a `sourceType` override. Default is the
fallback.

### D-3. Conservative single-assignment alias model {#d-3}

`buildAliases` is two passes, first-write-wins, no reassignment
tracking. Trade-off:

- **What we lose:** scripts that reassign tracked variables get
  reported with their first-assignment surface, not their final-value
  surface. The forensic bias (D-3 of the principles list) makes this
  the right default: over-report > miss.
- **What we gain:** ~50 lines of code instead of ~500. No SSA, no
  control-flow analysis, no fixed-point iteration. Two simple walks
  over `VariableDeclarator`.

In practice, real detector code doesn't reassign payload-tracking
variables — they build an object, stuff it with values, and
exfiltrate. The pattern that breaks the model (`d = {...}; d = {...}`)
is hypothetical.

If this changes, the upgrade path is to add a "shadow on reassignment"
mode behind a flag. The current model is the right zero-config
default.

### D-4. Wildcard-suffix keys {#d-4}

The catalog distinguishes prefix keys (`navigator.userAgent`) from
wildcard suffix keys (`*.toDataURL`). Reasons:

- **Prototype methods don't have a single root.** `canvas.toDataURL`,
  `c.toDataURL`, `el.toDataURL`, `offscreenCanvas.toDataURL` —
  detectors don't bind these consistently. A wildcard catches them
  all without forcing the catalog to enumerate every binding shape.
- **Argument matching covers the polymorphism.** `*.getContext`
  exists once with three `argMatch` filters (`["2d"]`, `["webgl",
  ...]`, `["webgpu"]`) routing to three categories.

The matcher's `chainMatches` handles both shapes in ~30 lines. Cost
is negligible.

### D-5. `argMatch` is the only side condition {#d-5}

The matcher could grow other side conditions — match only when
called from a `try` block, only when followed by a specific sink,
only inside a specific function. We deliberately keep it to
`argMatch`. Reasons:

- **Predictability.** A `Finding` is "this access satisfies this
  catalog entry by chain and first-string-arg." More conditions
  would make the matcher harder to reason about for catalog
  authors.
- **Composability.** Anyone who wants conditional rules can build
  them downstream against the JSON report. The static catalog
  stays a pure lookup table.

### D-6. Multi-match findings {#d-6}

An access can satisfy multiple catalog entries (a
`Function.prototype.toString` call matches both `*.toString` and
`Function.prototype.toString`). The matcher emits both findings.

**Rejected alternative:** "most specific wins" — emit only the
longest matching key. Tempting but wrong: the `*.toString` entry
exists specifically to catch the introspection-trick *pattern*
across receivers, and missing it because a more specific entry
also matched would hide the signal.

The renderer groups by category and severity, so the two findings
land next to each other naturally; the human reading the report
sees both interpretations.

### D-7. No transpiler support {#d-7}

The analyzer only parses JavaScript. No JSX, no TypeScript, no Flow.

**Rejected alternative:** a `transpile` step. Reasons against:

- **Detector blobs are JS.** The point is to read what shipped to
  the browser. By the time it's running on a target's page, every
  transpiler step has already happened.
- **Transpilers change ASTs.** A TypeScript pass could rewrite
  `var n = navigator` into `let n = navigator` (no-op) or worse,
  hoist a binding, breaking alias resolution. The static pass
  reading transpiled output is reading something the browser
  never sees.

Workaround: if you have a `.ts` source, run `tsc` and feed the
output through `script2builtins`. This is a one-step decision per
caller; baking it in would constrain everyone.

### D-8. The `Report` shape is a subset of `RuntimeReport` {#d-8}

`Report` (this package) and `RuntimeReport` (the runtime package)
share every field. The runtime adds `provenance` per finding,
a few summary fields (`runtimeOnlyKeys`, `staticOnlyKeys`,
`bufferOverflows`), and per-script analysis (`scripts[]`,
`events[]`).

This is load-bearing. The runtime package's merger reads `Report`s
produced by the static path of every captured script and unions
them with the runtime trace; if the shapes diverged the merger
would need a translation layer. Today it doesn't.

The cost is that adding a field to `Report` requires a corresponding
addition (or alias) on `RuntimeReport`. The two ledgers cross-
reference each other for this reason.

### D-9. `--include-unknown` is opt-in {#d-9}

Accesses that don't match a catalog entry surface in
`report.unknownAccesses` only when `includeUnknown: true`. Reasons:

- **Signal-to-noise.** Most unmatched accesses are uninteresting
  (built-in JS methods, libraries the script imports). Putting
  them all in the report by default drowns the matched findings.
- **Catalog-growth feedback loop.** Run `--include-unknown` on a
  detector blob, scan the output for fingerprint-shaped chains
  that didn't match, file PRs to add them. That's the catalog
  growth path.

Default off because most users want the findings, not the
diagnostic stream.

### D-10. Renderer ANSI-by-default-on-TTY {#d-10}

The CLI emits ANSI escape codes when stdout is a TTY and strips
them when piped. `--no-color` is the explicit override. The
default tracks the usual Unix convention (`isatty`); the
`--no-color` flag is for the case where the default is wrong
(scripts running in CI that pipe to a file but want a TTY-style
terminal in playback).

JSON output never emits ANSI. The renderer is bypassed entirely
for `--json`.

### D-11. `safeDecode` around `decodeURIComponent` {#d-11}

`maybeQueryStringPayload` calls `decodeURIComponent` on each
key/value of a URL query string. A malformed percent escape
(`%ZZ`, truncated `%E`, etc.) used to throw `URIError` and abort
analysis of the whole script.

The fix wraps `decodeURIComponent` in a try/catch that falls back
to the raw bytes. The cost is per-key; a single bad escape now
degrades one entry rather than killing the report. See
[CHANGELOG](https://github.com/StackedQueries/script2builtins/blob/main/CHANGELOG.md#unreleased)
under `decodeURIComponent DoS`.

### D-12. Object spread support {#d-12}

`{ ...{ a: navigator.x }, b: y }` used to silently drop `a` because
the classifier didn't recurse into `SpreadElement`. Now:

- `SpreadElement` of inline `ObjectExpression` → recurse, flatten
  entries in.
- `SpreadElement` of `Identifier` → record an opaque marker entry
  (`key: "...x", refName: "x"`) so the downstream resolver can
  chase it via the value map.

The second case isn't fully resolved end-to-end yet — the resolver
follows `refName` for direct-chain values but doesn't recurse into
nested object-literal origins. Tracked as a future task. The
current state captures more than the old behavior without making
the wrong claim.

### D-13. `parseRuntimeBody` lives here, not in the runtime package {#d-13}

`parseRuntimeBody(body, apis)` turns a serialized request-body
preview from `script2builtins-runtime` into a `PayloadInfo`. It
lives in `script2builtins/analyze` rather than in the runtime
package itself.

Why: the runtime trap captures bodies as preview shapes (`string`,
`json`, `urlsearchparams`, `formdata`, `blob`, `binary`, `empty`).
The parsing of those previews into structured entries — JSON
decode, key flattening, url-encoded fallback, catalog matching —
is the same work the AST tracer does after `tracePayload`. Putting
it next to the AST tracer means:

- **One catalog, one matcher** for both static and runtime
  payloads.
- **The runtime package stays thin.** It does instrumentation
  and event capture; it doesn't parse payloads.
- **Downstream tools** can re-parse trapped bodies from a HAR
  file or request log without depending on the runtime package.

The seam is the new `RuntimeBody` type, also exported from
`script2builtins/analyze`.

### D-14. `matchByLeafName` tiered preference {#d-14}

The runtime trapper sees serialized payloads with mangled keys —
`{ "ua": "...", "wd": true }`, or sometimes the canonical names
verbatim. `parseRuntimeBody` resolves entries by leaf name when
the chain doesn't have a canonical prefix.

The catalog has multiple entries that end in the same leaf:
`navigator.platform`, `navigator.userAgentData.platform`, and
`*.platform`. Picking is heuristic; tiers favor the canonical
`category.leaf` shape over nested or wildcard variants:

- Tier 1: concrete length-2 (`navigator.platform`)   ← canonical
- Tier 2: concrete length ≥ 3 (`navigator.userAgentData.platform`)
- Tier 3: wildcard (`*.platform`)
- Tier 4: bare global (`platform`)

`__proto__`-containing keys are dropped at the gate — they describe
an introspection path, not a payload target.

The tiers are deliberately fixed (not configurable). The tradeoff
is: a Tier-1 false match (catalog entry that names a payload field
that *happens* to have the same name as a more interesting nested
entry) is rare; the reverse — preferring the deeper entry and
mis-classifying mainstream `platform`/`userAgent`/`webdriver` —
is common in real detector payloads. The current ranking handles
both seen datasets well.

### D-15. `URLSearchParams` accepts all three init forms {#d-15}

The original tracer only handled the object-literal init form of
`new URLSearchParams({...})`. The other two forms are common in
real beacons:

- **String init.** `new URLSearchParams("ua=" + navigator.userAgent)` —
  resolves via `resolveStaticString` when the concat is static.
- **Array-of-pairs init.** `new URLSearchParams([["ua", navigator.userAgent]])` —
  walked element-by-element.

This came out of running the analyzer against a real DataDome blob
that used array-init for its exfiltration body. The expected output
was a list of leaked APIs; the actual output was an empty payload.
Fix went in alongside D-12.

### D-16. `Reflect.get` and descriptor-getter accesses are reported, not resolved {#d-16}

The catalog has entries for `Reflect.get`, `Reflect.set`,
`Object.getOwnPropertyDescriptor`, and the `__lookupGetter__` /
`__lookupSetter__` patterns. These are flagged as
`botDetectionTell: true` introspection surfaces.

What we don't do: try to track that
`Reflect.get(navigator, "userAgent")` is reading
`navigator.userAgent`. Reasons:

- **Static tracking is hostile to write.** The first arg has to be
  resolved to the actual `navigator` object (often via an alias
  chain), the second to the literal `"userAgent"` (might be a
  dynamic key), and the call site has to be linked back to the
  catalog entry for `navigator.userAgent` to register a hit on
  the *right* entry.
- **The runtime layer does this trivially.** Its `trapReflectGet`
  option (opt-in) wraps `Reflect.get` and emits an access event
  with the resolved chain.

Reporting the introspection surface is the right level of effort:
"this script uses `Reflect.get` extensively" is enough signal to
pair the script with the runtime layer.

### D-17. Per-file CLI separator instead of structured output {#d-17}

When the CLI receives multiple files, text-mode output separates
them with a row of `─` and a blank line. JSON-mode output is an
array of `Report` objects.

Considered alternatives: a single concatenated text report (loses
per-file source attribution); structured headers with file names
(adds noise to single-file output, which is the common case). The
current shape is minimal and works in both pipe-to-`less` and
diff-via-grep workflows.

---

## Smells caught in review

### S-1. Conditional / ternary values in payloads (open)

`{ ua: cond ? a.b : c.d }` — both surfaces get walked, neither
gets pinned to the sink. The fix is to teach `classifyValue` to
recognize `ConditionalExpression` and emit either both branches
or an unknown-with-branches marker. Today it returns `null`.

Not yet prioritized because: in real detectors, ternary in
payload values is rare; the surfaces still surface in `findings`
just not in `leakedApis`.

### S-2. Template-literal URL substitution (open)

```js
fetch(`https://collector.example/c?ua=${navigator.userAgent}`);
```

Sink emitted, URL `null`, `urlSnippet` set, query unparsed. Fix:
extend `resolveStaticString` to emit a chain-list when expressions
are present, then have `maybeQueryStringPayload` resolve each
substitution. Half a day of work; not yet scheduled.

### S-3. Cross-function payload flow (deferred)

`fetch(url, JSON.stringify(wrap(navigator.x)))` — the wrapper call
hides the chain. Proper fix needs intra-procedural data-flow at
minimum, possibly inter-procedural. Out of scope for a forensic
tool; the runtime package catches it for free.

### S-4. Reassignment shadowing (deferred)

First-write-wins on aliases and values. Tracked as a hypothetical
issue; no real detector has surfaced this in practice.
Documented in [Limits](limits.html#6-reassignment-ignored) so
consumers can plan around it.

### S-5. Inline-`new` XHR (deferred)

`new XMLHttpRequest().open(...).send(...)` chained inline (no
binding) isn't tracked through the state table. Detectors all
bind to a local before calling `.open`; this hasn't bitten.
Easy fix if it ever does: emit a synthetic instance for
chained-`new` patterns.

### S-6. Array values in payloads (open)

`{ fp: [a.b, c.d] }` — array literal returns `null` from
`classifyValue`. Surfaces appear in `findings` but not in the
sink's `leakedApis`. Fix: extend `classifyValue` to recognize
`ArrayExpression` and emit a synthetic entry per element. Same
priority as S-1.

### S-7. SpreadElement of nested identifier (partial)

`{ ...captured }` where `captured` is itself an object-literal
origin doesn't fully recurse — we record the marker entry but the
downstream resolver follows only `chain` / `literal` origins.
Fix: extend `entryToPayloadEntry` to recurse into `object-literal`
origins via the spread marker. Tracked alongside D-12.

---

## Versioning and release strategy

- **SemVer.** Pre-1.0 the catalog is unstable; minor bumps allowed
  on any release that adds entries. The matcher / walker / sink
  scanner are more stable — changes get changelog notes.
- **Catalog growth is a minor bump.** `0.1.x → 0.2.0` when
  `ALL_APIS` adds a new category file or a significant set of
  entries. Single-entry additions are patch-level.
- **Report shape changes are major bumps.** Adding fields to
  `Report` is minor (additive); removing or renaming is major.
- **The runtime package pins to a tight range.** A breaking
  catalog shape change on this package needs a corresponding
  runtime release.

---

## Testing strategy

| Layer                          | Test type    | Location               |
|--------------------------------|--------------|------------------------|
| Type shapes                    | `tsc --noEmit` in CI | `tsconfig.json`  |
| Parser fallback                | unit         | `test/parse.test.ts`   |
| Alias resolution               | unit         | `test/aliases.test.ts` |
| Walker reference detection     | unit         | `test/walk.test.ts`    |
| Matcher (prefix / wildcard / argMatch) | unit | `test/match.test.ts`   |
| Sink discovery                 | unit         | `test/sinks.test.ts`   |
| Payload tracer                 | unit on fixtures | `test/payload.test.ts` |
| `parseRuntimeBody`             | unit         | `test/runtime-body.test.ts` |
| End-to-end `analyze`           | snapshot     | `test/analyze.test.ts` |
| Renderer                       | snapshot     | `test/render.test.ts`  |

`npm test` runs vitest. The snapshot tests live next to the
`examples/` directory; updating a fixture is `vitest -u`.

The load-bearing test is the matcher: every catalog entry is
exercised in at least one access pattern. New entries that don't
add an exercise are caught in review.

---

## Maintainability principles

1. **Each module has a one-paragraph header comment.** Read it
   before touching the file.
2. **Public symbols have JSDoc.** Even one-line types. Read your
   own types in six months.
3. **Hard caps are named constants.** `DEFAULT_SNIPPET` (snippet
   length), `SEV_RANK` (severity ordering), the global-roots set.
   No magic numbers.
4. **The "Limits" page is honest.** When we can't see something,
   we say so. Limits is part of the contract; promising surfaces
   we don't actually catch erodes user trust faster than
   documented gaps.
5. **The catalog is split per category.** New entries go in one
   file. PR review is reading 5–10 added lines, not scrolling a
   2K-line monolithic table.
