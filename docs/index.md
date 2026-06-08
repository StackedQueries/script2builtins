---
title: script2builtins
nav_order: 1
---

# script2builtins

A forensic toolchain for **bot-detection and browser-fingerprinting
JavaScript**. Feed it a hostile script — a `curl` dump, a Playwright
capture, an Akamai / DataDome / PerimeterX / Cloudflare / reCAPTCHA blob —
and it tells you which browser APIs and JS builtins the script touches,
which network sinks it reaches, and what it ships back to the server.

The toolchain is three packages that all speak the **same report shape**
(`RawAccess`, `NetworkSink`, `Finding`), so their findings compose into a
single unified picture:

| Package | Role | Docs |
|---|---|---|
| **`script2builtins-knowledge`** | The shared API catalog (~460 fingerprint surfaces), `watchedRoots`, and the endpoint classifier. Versions independently so catalog updates don't require an analyzer release. | [Catalog reference →](knowledge/) |
| **`script2builtins`** | The **static** AST analyzer. Reads off the *full* surface area a script *could* probe — including code that didn't run under the current UA/viewport — with zero runtime deps beyond `acorn`. | [Static analyzer →](static/) |
| **`script2builtins-runtime`** | The **dynamic** analyzer. Drives a real Chromium with Playwright, traps every catalog API + sink + dynamic-execution point, and observes what the script *actually did*. | [Runtime analyzer →](runtime/) |

## Static or runtime — which do I want?

They answer different questions and are designed to be used together:

- **Static** (`script2builtins`) answers *"what does this script's source
  say it will do?"* It is fast, browser-free, and enumerates the full set
  of checks — including branches gated behind conditions that didn't fire.
  It has four hard blind spots: code built inside `eval` / `Function`
  strings, fully dynamic property keys, `Reflect.get` / descriptor-getter
  trampolines, and anti-debug surfaces.
- **Runtime** (`script2builtins-runtime`) answers *"what did the script
  actually do when this browser loaded the page?"* It closes all four
  static blind spots by observing real execution, and recursively analyzes
  any source it sees constructed at runtime.

Because both emit the same structs, a static report and a runtime report
merge into one. See the runtime's [Static vs runtime](runtime/static-vs-runtime.html)
page for a side-by-side of what each layer sees on the same script, and
the static analyzer's [Limits](static/limits.html) page for the explicit
blind-spot inventory.

## Quick start

The unified `s2b` CLI ships with the runtime package and dispatches by
what you give it (installing it transitively installs the static analyzer):

```sh
npm install -g script2builtins-runtime
npx playwright install chromium    # only needed for dynamic mode

s2b detector.js                    # static (no browser)
s2b -                              # static, source from stdin
s2b detector.js --dynamic          # wrap file in HTML harness, drive in browser
s2b https://target.example/        # dynamic: browser + traps + auto-static
s2b https://target.example/fp.js --static-only   # fetch URL, static only
```

Static-only? Install just the analyzer and skip the browser download:

```sh
npm install -g script2builtins
script2builtins detector.js --json | jq '.findings[]'
```

## Documentation map

### Shared catalog — `script2builtins-knowledge`
- [Catalog reference](knowledge/) — `ALL_APIS`, `watchedRoots`, the endpoint classifier, and the SoK layer taxonomy

### Static analyzer — `script2builtins`
- [Overview](static/) — what it is and why static at all
- [Architecture](static/architecture.html) — the four-stage pipeline
- [Analysis flow](static/analysis-flow.html) — how data moves through it
- [Payload tracer](static/payload-tracer.html) — how exfiltration is traced
- [Catalog reference](static/catalog.html) — the `ApiDefinition` contract
- [Recipes](static/recipes.html) — common reverse-engineering workflows
- [Limits](static/limits.html) — what static analysis cannot see
- [Design review](static/design-review.html) — decisions and rationale

### Runtime analyzer — `script2builtins-runtime`
- [Overview](runtime/) — what it is and why a runtime layer
- [Architecture](runtime/architecture.html) — what the parts are
- [Execution flow](runtime/execution-flow.html) — diagrams of how data moves
- [Trap internals](runtime/trap-internals.html) — how the in-page traps are built
- [Static vs runtime](runtime/static-vs-runtime.html) — what each layer sees
- [Recipes](runtime/recipes.html) — dynamic-analysis workflows
- [Catalog reference](runtime/catalog.html) — the runtime view of the catalog
- [Limits](runtime/limits.html) — what even runtime can't see
- [Stealth mode](runtime/stealth-mode.html) — evading anti-instrumentation
- [Design review](runtime/design-review.html) — decisions and rationale
