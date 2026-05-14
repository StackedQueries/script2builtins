---
title: script2builtins
nav_order: 1
---

# script2builtins

`script2builtins` is the **static** half of the
[script2builtins](https://github.com/yourorg/script2builtins) toolchain.
You feed it a script — a `curl` dump of `https://detector.example/check.js`,
a Playwright page-source capture, an Akamai / DataDome / PerimeterX /
Cloudflare blob, anything that parses as JavaScript — and it tells you,
in seconds, three things:

1. **Every catalog API the script touches.** Property gets, method calls,
   aliased reads (`var n = navigator; n.webdriver`), computed-string keys
   (`navigator["user" + "Agent"]`), and `argMatch`-routed method calls
   (`getContext("2d")` vs `getContext("webgl")`) — all collapsed against
   ~460 cataloged fingerprint surfaces.
2. **Every network sink the script reaches.** `fetch`, `XMLHttpRequest`,
   `navigator.sendBeacon`, `WebSocket`, `EventSource`, `Worker` /
   `SharedWorker` / `importScripts`, `Image` / `script` `src` writes,
   and `location` navigations — with the resolved URL and HTTP method
   when statically knowable.
3. **What it ships.** For each sink with a body, a static trace of the
   request payload (object literal, `JSON.stringify(tracked)`,
   `FormData` accumulator, `URLSearchParams`, URL query) with each key
   resolved back to the cataloged API that produced its value.

The output is JSON-serializable and the CLI also renders a human-readable
report. The whole pipeline is ~3K lines of TypeScript with zero runtime
dependencies beyond `acorn` / `acorn-walk`.

## Quick start

```sh
npm install -g script2builtins
```

```sh
script2builtins detector.js                              # text report
script2builtins examples/*.js --min-severity medium      # filter
curl -sL https://example.com/fp.js | script2builtins -   # stdin
script2builtins detector.js --json | jq '.findings[]'    # machine-readable
```

Library:

```ts
import { analyze, renderText, ALL_APIS } from "script2builtins";

const report = analyze(source, { name: "detector.js" });
console.log(renderText(report, { minSeverity: "medium" }));

for (const sink of report.networkSinks) {
  for (const e of sink.payload?.entries ?? []) {
    if (e.leakedApi) console.log(sink.url, e.key, "→", e.leakedApi.key);
  }
}
```

## Why static at all?

Because the alternative — running an arbitrary hostile blob in your own
browser — has obvious downsides, and because once you can *name* the
surfaces a detector cares about you can patch your runtime surgically
rather than guess. A 5 KB minified detector usually probes 30+ APIs;
reading the generated report is faster than reading the script.

The static pass also gives you the **full surface area**, including
code that didn't execute under the current user-agent / viewport /
A/B slot. Detectors routinely ship a superset of checks and enable
some per condition — the static pass enumerates the full set.

## The companion runtime

The static pass cannot see four classes of thing: code constructed
inside `eval` / `Function` strings, fully dynamic property keys,
`Reflect.get` / descriptor-getter trampolines, and anti-debug
surfaces. The companion package
[`script2builtins-runtime`](https://github.com/yourorg/script2builtins-runtime)
drives a real Chromium browser, traps every catalog API + sink +
dynamic-execution point, and emits findings in the same shape this
package produces. The two compose into one unified report — see
[Limits](limits.html) for the explicit blind-spot inventory.

## Architecture in one sentence

A four-stage pipeline (`parse` → `walkProgram` → `matchAccesses` →
`scanSinks`) drives a catalog of `~460` `ApiDefinition` entries against
the source AST and emits a JSON-serializable `Report`; the renderer is
a thin layer on top.

For the full picture:

- [Architecture](architecture.html) — what the parts are
- [Analysis flow](analysis-flow.html) — diagrams of how data moves
- [Payload tracer](payload-tracer.html) — how exfiltration is traced
- [Catalog reference](catalog.html) — the `ApiDefinition` contract
- [Recipes](recipes.html) — common reverse-engineering workflows
- [Limits](limits.html) — what static analysis cannot see
- [Design review](design-review.html) — decisions and rationale

## What it sees through

- **Aliases.** `var n = navigator; n.webdriver` → reported as
  `navigator.webdriver`. Multi-hop: `var n = navigator; var p = n.plugins;
  p.length` → `navigator.plugins`.
- **Computed string keys.** `navigator["userAgent"]`,
  `navigator["user" + "Agent"]`, template literals with no expressions.
- **String aliases.** `var k = "userAgent"; navigator[k]`.
- **Global stripping.** `window.navigator.x`, `self.navigator.x`,
  `globalThis.navigator.x` all collapse to `navigator.x`.
- **Argument matching.** `getContext("2d")` vs `getContext("webgl")` vs
  `getContext("webgpu")` are routed to different catalog entries.

## What it can't see (and why)

A small residual set of cases stays beyond static reach. See
[Limits](limits.html) for the full inventory; the short version is
anything constructed inside an `eval` string, anything keyed by a
fully dynamic expression, anything routed through `Reflect.get`, and
any anti-debug check that depends on runtime byte patterns. For full
coverage pair this package with `script2builtins-runtime`.
