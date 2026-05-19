# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (0.2.x hardening + coverage expansion)

#### Runtime leak detection (fix)

- **Runtime sinks now populate `leakedApis`.** `toNetworkSinks` re-parses
  the trap-side body preview through the new
  [`parseRuntimeBody`](https://github.com/StackedQueries/script2builtins) helper
  in `script2builtins/analyze` (handles `string` / `json` /
  `urlsearchparams` / `formdata` / `blob` / `binary` / `empty`
  shapes; flattens nested JSON; matches keys by canonical leaf name).
  Previously `runtime` `leakedApiCount` was always 0 even when
  fingerprint payloads were captured.

#### Driver hardening

- **`bufferOverflowsByKind`** in `summary` — per-event-kind drop
  counters (`access`, `sink`, `hazard`). High-signal drops are
  surfaced in the text report and flagged red.
- **`runHarness` modes** — `harnessMode: "data" | "file" | "http-harness"`:
  - `"data"` (default, unchanged) — base64 `data:` URL, opaque origin.
  - `"file"` — temp HTML file served via `file://`.
  - `"http-harness"` — spins a localhost HTTP server so the page
    has a real `http://127.0.0.1` origin (cookies, `localStorage`,
    same-origin fetches behave normally). Server is started per-run
    and closed on completion.
- **CLI numeric-arg validation** — `--nav-timeout`, `--idle`,
  `--max-hits` now reject NaN, missing values, and negative integers
  with a clear error message.
- **`buildHarnessHtml` injection-proof** — embeds the script via
  `<script src="data:text/javascript;base64,…">` instead of inlining
  and regex-escaping `</script>`. Closes a corner case where HTML
  parser-state confusion (`<!--<script>`, `</script ` with whitespace)
  could escape the script context.

#### Trap-side hardening

- **Random per-build channel name.** Default channel is now
  `__s2b_<6 hex bytes>` instead of the previous fixed `__s2bRt`.
  `Session.channelName` exposes the chosen name. Override via
  `attach({ channelName })` for tests / external observation.
- **`registerWrapper(wrapped, original)` helper** — single
  registration site for `Function.prototype.toString` masking; every
  wrapper (sinks, descriptor getters, dynamic-exec, Worker, etc.)
  routes through it. Sandbox-tested: wrapped `eval.toString()`
  returns native-looking source post-trap.
- **`trapReflectGet` (opt-in)** — wraps `Reflect.get` to surface
  accesses on direct (non-Proxy) root references. Off by default
  because `Reflect.get` is hot in engine internals. CLI:
  `--trap-reflect-get`.

#### Coverage expansion

- **`trapWorkers` (default ON)** — wraps classic `new Worker(url)`
  constructors and replaces them with a bootstrap blob URL that
  `importScripts(<trap blob>); importScripts(<user url>)`. The trap
  source is published as `globalThis.__s2bWorkerTrap` via a sibling
  init script. Module workers (`{type: "module"}`) and
  `SharedWorker` are passed through with only the sink event
  (documented limitation in [`docs/limits.md`](./docs/limits.md)).
- **srcdoc iframe capture** — driver walks every frame for
  `<iframe srcdoc=…>` attributes and runs `extractScriptBodies` to
  pull inline `<script>` bodies out of the srcdoc HTML. New
  acquisition type `"srcdoc"`; `summary.srcdocScripts` exposes the
  count. Non-JS script types (`application/json`, `application/ld+json`)
  are skipped.

#### API surface additions

- `Session.channelName: string` — read the in-page channel name
  selected for this attach.
- `AttachOptions.channelName?` — override the random default.
- `AttachOptions.trapReflectGet?` — enable `Reflect.get` wrap.
- `AttachOptions.trapWorkers?` — disable worker bootstrap if needed
  (default `true`).
- `RunHarnessOptions` exported from the main entry; includes
  `harnessMode` and `port`.
- `extractScriptBodies(html)` — exported from `runner/driver.js` for
  external callers that want to feed srcdoc-style HTML through the
  pipeline.

### Initial release

- `attach(context)` core primitive — bind instrumentation to an existing Playwright `BrowserContext`.
- `run({ url })` turn-key wrapper — launch Chromium, attach, navigate, drain, report.
- `runHarness(filePath)` — wrap a local JS file in an HTML harness and drive it through `run`.
- `analyzeUrl(url)` — fetch a URL and run the static analyzer with no browser launch.
- Unified `s2b` CLI — dispatches static / dynamic / harness / static-from-URL based on input shape.
- Re-exports `analyze`, `renderText`, `ALL_APIS` from `script2builtins` so the runtime package is a single import surface.
- `buildTrapScript()` — generates a self-contained, hash-stable in-page trap script from the catalog.
- `Session` handle with `report({ since, flush })` for incremental reports during long-running automation.
- Per-script SHA-256 hashing — every captured script carries its hash; runtime events back-fill `scriptSha256` from the URL map.
- Per-event sequence cursor for stateless incremental drains.
- Trap script SHA-256 (`trapScriptSha256`) on the report — identifies the instrumentation that produced it.
- Report schema version (`reportVersion`, `catalogVersion`).
- Per-script `trapCoverage` — fraction of cataloged surfaces that fired at runtime.
- `runtimeOnlyKeys` / `staticOnlyKeys` gap summary.
- CDP `Debugger.setSkipAllPauses(true)` to neutralize `debugger`-statement detection traps.
- `Function.prototype.toString` masking for our wrappers (introspection defense).
- In-page event buffer with byte cap and drop-oldest overflow policy.
- Eval / Function / setTimeout-string interception with concrete source capture and recursive static analysis.
- Worker / SharedWorker constructor sink capture.
- GitHub Pages docs site under `docs/` covering architecture, execution flow, trap internals, static vs runtime, recipes, catalog reference, limits, design review.

### Known limits

See [`docs/limits.md`](./docs/limits.md). Highlights:

- Pre-existing pages at attach time are not instrumented (reported in `summary.preExistingPages`).
- Module workers (`{type: "module"}`) and `SharedWorker` bodies are NOT trapped in-scope; classic worker instrumentation runs via the bootstrap-blob path (`trapWorkers`, default on).
- `data:` URL harnesses have an opaque origin — use `harnessMode: "http-harness"` when the script needs a real same-origin (cookies / `localStorage`).
