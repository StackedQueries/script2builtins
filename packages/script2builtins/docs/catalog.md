---
title: Catalog reference
nav_order: 5
---

# Catalog reference

The catalog is the spec. Everything `script2builtins` reports is a
match against an `ApiDefinition` entry in the
[`script2builtins-knowledge`](https://github.com/StackedQueries/script2builtins/tree/main/packages/script2builtins-knowledge)
package; everything `script2builtins-runtime` traps is generated from
the same catalog at build time. Adding a fingerprint surface is a
one-line PR to that package.

## The `ApiDefinition` shape

```ts
interface ApiDefinition {
  key: string;              // "navigator.userAgent" or "*.toDataURL"
  category: string;         // "navigator" | "canvas" | "headless-tells" | …
  description: string;      // what the API leaks or signals
  severity: "info" | "low" | "medium" | "high";
  botDetectionTell?: boolean;
  evasion?: string;         // common patches in stealth toolchains
  argMatch?: string[];      // first-string-arg filter, e.g. ["2d"]
}
```

Every field is read in two places: by `matchAccesses` (to resolve a
chain) and by `renderText` (to display severity / description /
evasion). Most entries have all six fields; `botDetectionTell` and
`argMatch` are situational.

### Severity tiers

| tier     | meaning                                                                |
|----------|------------------------------------------------------------------------|
| `info`   | ubiquitous APIs that show up in plenty of legitimate code              |
| `low`    | fingerprint-relevant but low entropy or expected                       |
| `medium` | strong fingerprint signals (canvas/audio/WebGL surfaces)               |
| `high`   | bot-specific tells or high-leakage operations                          |

Use `--min-severity medium` on the CLI when reading a long report to
cut the `info` noise. The `botDetectionTell` flag is independent of
severity — many tells are `low` or `medium`; some `high` entries are
just high-leakage rather than bot-specific.

## Key shapes

Two forms:

1. **Prefix key.** `"navigator.userAgent"` — the access chain
   (after `window`/`self`/`globalThis` stripping) starts with these
   segments.
2. **Wildcard suffix.** `"*.toDataURL"` — the chain ends with these
   segments, root is irrelevant. Used for prototype-side methods
   where the root identifier is whatever local the script chose
   (`canvas`, `c`, `el`, `offscreen`, …).

Both forms can be longer than two segments:

```
"navigator.userAgentData.getHighEntropyValues"  ← prefix, length 3
"*.getContext"                                  ← wildcard, length 2
```

### `argMatch` for polymorphic methods

`getContext("2d")` and `getContext("webgl")` map to different
fingerprint categories — canvas vs WebGL. The catalog handles this
by repeating the same key with different `argMatch` filters:

```ts
{ key: "*.getContext", argMatch: ["2d"],     category: "canvas",  severity: "medium", … }
{ key: "*.getContext", argMatch: ["webgl",
                                  "webgl2",
                                  "experimental-webgl"],
                                              category: "webgl",   severity: "medium", … }
{ key: "*.getContext", argMatch: ["webgpu"],  category: "webgpu",  severity: "medium", … }
```

An access matches only if `access.called` is true AND
`firstStringArg` is in `api.argMatch`. The walker resolves
`firstStringArg` through `resolveStaticString`, so
`getContext("2" + "d")` works.

## Categories

```
audio              canvas              css                document
events             headless-tells      intl                introspection
math               media-capabilities  media-permissions   navigator
sensors            speech              storage-fonts       svg
timing             wasm                webgl               webrtc
window-screen      workers
```

Each is one file in `script2builtins-knowledge/src/<category>.ts`
and exports `<category>Apis: ApiDefinition[]`. The category in the
entry itself doesn't have to match the filename, but conventionally
does.

Roughly 460 entries total across all files, with 151 marked as
strong bot-detection tells (`botDetectionTell: true`).

## `watchedRoots()` — the bridge to the walker

[`script2builtins-knowledge/src/index.ts`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins-knowledge/src/index.ts)
exposes `watchedRoots(apis = ALL_APIS): Set<string>`. It returns:

- Every leftmost segment of every non-wildcard catalog key.
- A fixed prelude of hazard call targets (`eval`, `Function`,
  `setTimeout`, `setInterval`) and always-watched globals
  (`navigator`, `document`, `window`, `screen`, `location`,
  `performance`, `chrome`, plus dozens more).

The walker uses this set to decide whether a bare identifier
reference is worth emitting an access for. If you add a new catalog
entry whose key starts with a brand-new root (e.g.
`"BarcodeDetector.detect"`), the root is automatically in
`watchedRoots()` because the function walks `ALL_APIS` after
seeding its prelude.

## Extending the catalog

To add a new surface:

```ts
// packages/script2builtins-knowledge/src/<category>.ts
export const <category>Apis: ApiDefinition[] = [
  // … existing entries …
  {
    key: "navigator.gpu.requestAdapterInfo",
    category: "webgpu",
    severity: "high",
    botDetectionTell: true,
    description: "Returns adapter vendor / architecture / device strings — GPU fingerprint.",
    evasion: "Override on the WebGPU adapter or block requestAdapter from resolving.",
  },
];
```

That's it. The entry shows up in `ALL_APIS` on the next build, the
walker watches `navigator`, the matcher routes the access to the new
entry, and the renderer displays it. The runtime package picks it up
on its next build with no code changes.

### When you also need to touch root code

Two cases that need more than a one-line PR:

1. **A new key shape that isn't `root.path…` or `*.path…`.** E.g.
   `"this.x"` would match `ThisExpression.x` only — the matcher
   compiles parts via `key.split(".")` so a literal `this` head
   works, but the walker only emits `["this", ...]` chains when the
   receiver is `ThisExpression`. If you want a different special
   head, add a case to `walk.ts:resolveRoot`.
2. **A new always-watched global.** If the script can use the
   identifier *bare* (not as a property of `window`) AND it doesn't
   appear in any catalog key's leftmost position, add it to the
   `watchedRoots()` prelude.

In the year the catalog has grown by ~3× we have not needed (1).
(2) happens occasionally — `BroadcastChannel`, `cookieStore`,
`crossOriginIsolated` were all added that way.

## Anti-patterns when adding entries

- **Don't duplicate.** `*.toString` already exists; don't add
  `Function.prototype.toString` unless you need a different
  severity / description specifically for the introspection use.
  The matcher will emit both `Finding`s for one access, which
  inflates `totalAccesses` and confuses the reader.
- **Don't put generic ECMAScript built-ins at `high` severity.**
  `Array.prototype.indexOf` is not a fingerprint tell, even though
  detectors use it. Save `high` for the bot-specific or
  high-leakage signals.
- **Don't add an entry whose only utility is `description`.** If
  the matcher will never resolve to this entry (e.g., a key with
  no real chain in source), it just clutters `ALL_APIS`. Document
  patterns in `evasion` notes on existing entries instead.
- **Don't forget `argMatch` on polymorphic methods.** A new
  `getContext`-style method without `argMatch` will match every
  call regardless of arg, conflating categories.

## Programmatic access

```ts
import { ALL_APIS, watchedRoots } from "script2builtins-knowledge";

console.log(ALL_APIS.length);              // ~460
console.log(watchedRoots().size);          // ~150 (varies with catalog growth)

// Tells only:
for (const d of ALL_APIS) {
  if (d.botDetectionTell) console.log(d.key, d.severity, d.evasion);
}

// Per category:
import { canvasApis } from "script2builtins-knowledge";
console.log(canvasApis.map(a => a.key));
```

The catalog is plain TypeScript — no validation, no schema, no
loader. The export is `as const`-ish in spirit; entries are frozen
at import time. If you want a JSON dump, `JSON.stringify(ALL_APIS)`
works.

## Catalog provenance

The entries come from two sources:

- **CreepJS.** [abrahamjuliot/creepjs](https://github.com/abrahamjuliot/creepjs)
  — both the live probe enumeration and the source code. CreepJS
  is the most thorough open-source fingerprinter; its check list
  is the closest thing to a canonical "what does a real detector
  probe" reference.
- **Academic literature.**
  [prescience-data/dark-knowledge](https://github.com/prescience-data/dark-knowledge)
  collects the relevant papers. Notably: 2022 AudioContext Browser
  Fingerprinting; 2022 DRAWNAPART (GPU timing); 2022 Browser-based
  CPU Fingerprinting (Snitch); 2020 Carnus / Fingerprinting in
  Style; 2020 Taming the Shape Shifter (eval / Function detection);
  2019 JavaScript Template Attacks; the 2019 Browser Fingerprinting
  Survey.

The entries' `evasion` notes lean on the open-source stealth
toolchains: `puppeteer-extra-plugin-stealth`, `rebrowser/patches`,
`undetected-chromedriver`, Playwright's own stealth recipes. Where
the academic literature gives a name to the technique (DRAWNAPART
for GPU timer-query fingerprinting, Snitch for `Atomics.wait`-based
CPU pipeline measurement, etc.), the entry mentions it.

## The catalog contract

In one direction:

1. **Any new `ApiDefinition` entry is matchable on the next build.**
   No additional plumbing required for prefix / wildcard keys with
   conventional root identifiers.
2. **`watchedRoots()` is the source of truth for bare-identifier
   accesses.** A new root added via a new catalog key is
   automatically watched.

In the other direction:

3. **The matcher never invents API keys.** If a chain has no
   catalog match it surfaces in `unknownAccesses` (with
   `includeUnknown`) but never gets a fabricated `ApiDefinition`.
4. **The matcher is shared with the runtime path.**
   `script2builtins-runtime` converts in-page events to `RawAccess`
   and feeds them to `matchAccesses` so a catalog change applies
   to both modes simultaneously.

This is the same contract documented on the runtime side, viewed
from the static end of the seam. Both packages depend on the
catalog being stable enough to diff across releases; the
`reportVersion` / `catalogVersion` slots in `RuntimeReport` exist
so consumers can detect when a catalog change broke their
downstream tooling.
