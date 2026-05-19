# script2builtins-runtime

Runtime instrumentation companion to
[`script2builtins`](../script2builtins). Drives a real Chromium against a
URL, traps every catalog API + every network sink + every dynamic-execution
point, and emits findings in the same shape the static analyzer produces.

## Why

The static analyzer is fast and cheap but has four hard-baked blind
spots: code inside `eval` / `Function` strings, fully dynamic property
keys, `Reflect.get` / descriptor-getter trampolines, and anti-debug
checks. This package closes all four by running the script in an
instrumented browser and emitting the same `RawAccess` / `NetworkSink`
structs the static pass produces, so the two reports compose into one.

## Install

```sh
npm install -g script2builtins-runtime
# dynamic mode only — skip if you'll only run static analysis:
npm install -g playwright
npx playwright install chromium
```

Requires Node 20+. `playwright` is a **peer dependency** — install it
yourself only when you need dynamic mode. Static-only users can skip it
and avoid the ~300 MB browser download. Installing this package
transitively installs `script2builtins`, so you don't need both — the
unified `s2b` CLI ships here.

## Quick start

One CLI, dispatched by what you give it. Static mode never launches a
browser:

```sh
s2b detector.js                       # static (file)
s2b -                                 # static (stdin)
s2b detector.js --dynamic             # wrap file in HTML harness, drive it
s2b https://target.example/           # dynamic (browser + traps + auto-static
                                      # on every captured script)
s2b https://target.example/fp.js --static-only
                                      # fetch URL, run static, no browser
```

Common flags: `--json`, `--out <dir>`, `--min-severity`,
`--no-color`. Dynamic-only: `--headless`, `--nav-timeout`, `--idle`,
`--ua`, `--harness-mode data|file|http-harness`, `--trap-reflect-get`.
`s2b --help` for the full list.

### Harness modes

When running against a file (`s2b detector.js --dynamic`), pick how the
harness HTML is served:

| mode             | origin                | when to use |
|------------------|-----------------------|-------------|
| `data` (default) | opaque `data:`        | cheapest; storage APIs behave differently from a real site |
| `file`           | opaque `file://`      | want relative imports to resolve from disk |
| `http-harness`   | real `http://127.0.0.1` | the script needs cookies, `localStorage`, or same-origin fetches |

The HTTP server is started per-run on an ephemeral port and shut down
on completion.

## Library

Same import surface for both modes:

```ts
import { analyze, run, analyzeUrl, renderRuntimeText } from "script2builtins-runtime";

// Static — no browser
const r1 = analyze(source, { name: "detector.js" });

// Static on a URL — fetch + analyze, no browser
const r2 = await analyzeUrl("https://example.com/fp.js");

// Dynamic — drives a browser, also runs static on every captured script
const r3 = await run({
  url: "https://target.example/",
  outDir: "./runs/automated",
  headless: true,
});

console.log(renderRuntimeText(r3, { minSeverity: "medium" }));

for (const f of r3.findings) {
  if (f.provenance === "runtime" && f.api.botDetectionTell) {
    console.log("RUNTIME-ONLY TELL:", f.api.key, f.callSites, "sites");
  }
}

// Inspect runtime exfiltration: now populated thanks to the runtime
// body re-parser (parseRuntimeBody from script2builtins/analyze).
for (const s of r3.reconstructedSinks) {
  for (const a of s.payload?.leakedApis ?? []) {
    console.log("LEAK", s.kind, s.url, "→", a.key);
  }
}
```

### Coverage flags

A few opt-in / opt-out levers tune the trap surface:

- **`channelName`** — the trap installs its drain channel under a
  random `window.__s2b_<6 hex bytes>` per attach. `Session.channelName`
  exposes the chosen name. Override with `attach({ channelName: "…" })`
  for tests / external observation.
- **`trapWorkers`** (default `true`) — wraps classic `new Worker(url)`
  to bootstrap the trap inside worker scope via
  `importScripts(<trap blob>)`. Module workers and `SharedWorker`
  pass through unchanged.
- **`trapReflectGet`** (default `false`) — wraps `Reflect.get` so
  introspection trampolines that hold non-Proxy root references
  still surface accesses. Off by default because engine internals
  call `Reflect.get` heavily. Enable for high-coverage forensic runs:
  `s2b <url> --trap-reflect-get`.
- **`trapDynamicExec`** (default `true`) — `eval`, `Function`,
  `setTimeout("string", …)`, `setInterval("string", …)`.
- **`useProxyRoots`** (default `true`) — install root Proxies for the
  curated `navigator`, `screen`, `document`, … set. Set false to fall
  back to descriptor-only patching.
- **`hardenIntrospection`** (default `true`) — `Function.prototype.toString`
  masking so wrapped functions still look native.

### Sources the runtime captures

Each entry in `RuntimeReport.scripts` carries an `acquisition` tag:

- `network` — fetched as a JS response (`text/javascript`, `.js`, etc.).
- `inline` — `<script>` tag without a `src` attribute.
- `srcdoc` — inline `<script>` inside an `<iframe srcdoc>` attribute.
- `eval` / `function-ctor` / `settimeout-string` — code captured from
  the dynamic-execution traps.

`summary.networkScripts`, `inlineScripts`, `srcdocScripts`, and
`evalScripts` are the headline counts.

## Docs

Full docs live in [`docs/`](./docs/) and are served via GitHub Pages at
`https://StackedQueries.github.io/script2builtins-runtime/`.

- [Architecture](docs/architecture.md)
- [Execution flow](docs/execution-flow.md) — full processing diagrams
- [Trap internals](docs/trap-internals.md)
- [Static vs runtime](docs/static-vs-runtime.md)
- [Recipes](docs/recipes.md)
- [Catalog reference](docs/catalog.md)
- [Limits](docs/limits.md)
- [Design review](docs/design-review.md) — decisions, smells, rationale

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for phase status, open design
questions, and per-task tracking.

## License

MIT
