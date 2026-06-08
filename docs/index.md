---
title: script2builtins-runtime
nav_order: 1
---

# script2builtins-runtime

`script2builtins-runtime` is the **dynamic** half of the
[script2builtins](https://github.com/StackedQueries/script2builtins) toolchain.
The static analyzer answers *"what does this script's source say it
will do"*. The runtime answers *"what did the script actually do when
this browser loaded the page"*.

Together they read off:

1. **Every catalog API the page touched.** Property gets, method calls,
   computed-key reads, and accesses routed through `Reflect.get` or
   descriptor-getter trampolines — anything the static AST pass can't
   see is observed at runtime.
2. **Every network sink the page reached.** `fetch`, `XMLHttpRequest`,
   `navigator.sendBeacon`, `WebSocket`, `EventSource`, `Worker`,
   `importScripts`, `Image`/script `src` writes, and `location`
   navigations — with the real URL, headers, and body bytes.
3. **Every dynamic execution site.** `eval`, `new Function`,
   `setTimeout("string", ...)`, and `import()` calls are intercepted,
   their constructed source is captured, and that source is recursively
   analyzed and merged into the report — closing the largest static
   blind spot.

The runtime emits findings in the same shape the static analyzer
produces (`RawAccess`, `NetworkSink`, `Finding`), so reports from both
paths compose into one.

## Quick start

```sh
npm install -g script2builtins-runtime
npx playwright install chromium    # only needed for dynamic mode
```

One CLI, dispatched by what you give it:

```sh
s2b detector.js                       # static (no browser)
s2b -                                 # static, source from stdin
s2b detector.js --dynamic             # wrap file in HTML harness, drive in browser
s2b https://target.example/           # dynamic (browser + traps + auto-static
                                      # on every captured script)
s2b https://target.example/fp.js --static-only
                                      # fetch URL, run static, no browser
```

Library — same import surface for both:

```ts
import { analyze, run, analyzeUrl } from "script2builtins-runtime";

const r1 = analyze(source, { name: "detector.js" });         // static
const r2 = await analyzeUrl("https://example.com/fp.js");    // fetch + static
const r3 = await run({ url: "https://target.example/",       // dynamic + static
                      outDir: "./runs/x" });
```

## Why a runtime layer?

The [Limits page](limits.html) of the static analyzer enumerates four
classes of blind spot — eval'd code, fully dynamic property keys,
`Reflect.get` / descriptor-getter trampolines, and anti-debug surfaces.
This package closes all four. See [Static vs
runtime](static-vs-runtime.html) for a comparison of what each layer
sees on the same script.

## Architecture in one sentence

A self-contained, catalog-driven trap script is injected via
Playwright's `addInitScript` before any page script runs; it Proxies
the watched roots, wraps the sinks, recurses into dynamic execution,
and drains structured events through a private channel that the
Node-side driver reconstructs into the static analyzer's report
shape.

For the full picture:

- [Architecture](architecture.html) — what the parts are
- [Execution flow](execution-flow.html) — diagrams of how data moves
- [Trap internals](trap-internals.html) — how the in-page traps are built
- [Design review](design-review.html) — decisions and rationale

## What it cannot still see

A small handful of cases remain — see [Limits](limits.html). The TL;DR
is anything that bypasses the JS engine entirely (e.g., raw GPU shader
side channels visible only through the rendered framebuffer) or that
the browser refuses to load (cross-origin frame contents you can't
script into).
