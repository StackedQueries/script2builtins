# Roadmap

The execution ledger for `script2builtins-runtime`. Phases, open
design questions, and outstanding work. Companion to
[`docs/design-review.md`](./docs/design-review.md) (decisions + smells)
and [`docs/execution-flow.md`](./docs/execution-flow.md) (diagrams).

---

## Current status

| Phase | Title                                         | Status        |
|-------|-----------------------------------------------|---------------|
| 0     | Scaffold package                              | ✅ complete    |
| 0b    | Unified CLI dispatcher                        | ✅ complete    |
| 0c    | Design review + hashing + attach pivot        | ✅ complete    |
| 1     | Browser-side trap library                     | ✅ complete    |
| 2     | Playwright driver + report merging            | ✅ complete    |
| 3     | eval / Function / setTimeout-string recursion | ✅ complete    |
| 4     | Proxy roots + Reflect / descriptor coverage   | ✅ complete    |
| 5     | Anti-anti-debug + introspection defense       | ✅ complete    |
| 6     | Unified renderer + docs site polish           | ✅ complete    |
| 7     | Audit fixes (leak-detection + hardening)      | ✅ complete    |
| 8     | Coverage expansion (workers, srcdoc)          | ✅ complete    |
| 9     | Operator-Synthesis-era coverage               | tracking       |

**Runtime package status:** 47/47 unit tests pass (trap, runner,
collect, merge, harness, srcdoc, CLI). End-to-end tested against
DataDome, Cloudflare, reCAPTCHA, hCaptcha (see
`../script2builtins_test/output/`). Runtime sinks now populate
`leakedApis` via the new `parseRuntimeBody` re-parser; classic-worker
bodies are instrumented in-scope; srcdoc iframes are surfaced.

**Static package status:** 78/78 tests pass.  Phase 7 added
`parseRuntimeBody` + `RuntimeBody` exports, SpreadElement / URLSearchParams
string-init / array-of-pairs-init handling, and a `safeDecode`
hardening fix for malformed URL escapes.

---

## What landed

### Phase 0 — Scaffold

Package skeleton, types, TS config, docs skeleton, license, gitignore.

### Phase 0b — Unified CLI dispatcher

Single `s2b` bin dispatches by input shape. Library re-exports
`analyze`, `analyzeUrl`, `run`. Static path verified end-to-end against
a captured detector.

### Phase 0c — Design review fixes

All 11 must-fix items resolved:

| ID    | Item                                                          | Resolution |
|-------|---------------------------------------------------------------|-----------|
| 0c-1  | `attach(context)` is the core primitive, `run()` wraps it     | ✅ `src/runner/driver.ts` |
| 0c-2  | Remove `kind` from `RuntimeEvent` base, only on derived types | ✅ `src/types.ts` (`RuntimeEventBase`) |
| 0c-3  | Add `scriptSha256` to every access/sink/hazard event          | ✅ via `RuntimeEventBase` + `attributeEvents` |
| 0c-4  | Add `trapScriptSha256` to `RuntimeReport`                     | ✅ `buildTrapScript` returns `{source, sha256}` |
| 0c-5  | Add `reportVersion` + `catalogVersion` fields                 | ✅ `REPORT_VERSION`, `catalogVersion()` |
| 0c-6  | Per-script bundle references events by index range, no dup    | ✅ `ScriptAnalysis.eventRange: [startSeq, endSeq]` |
| 0c-7  | `Session.report({ since, flush })` cursor semantics           | ✅ implemented + tested |
| 0c-8  | Remove dynamic import inside `runHarness`                     | ✅ direct top-level import |
| 0c-9  | Switch `script2builtins` dep to publishable form              | ⚠ kept `file:` link for dev; `scripts/prepare-publish.mjs` swaps before `npm publish` |
| 0c-10 | Pre-existing-pages caveat                                     | ✅ docs/limits.md + report.summary.preExistingPages |
| 0c-11 | `peerDependencies` decision                                   | ✅ kept as regular dep (D-11) |

### Phase 1 — Browser-side trap library

- `buildTrapScript(opts)` → `{ source, sha256, version, config }`.
- Self-contained IIFE generated from `ALL_APIS` + `watchedRoots()`.
- Pristine reference snapshot, event buffer with byte cap + drop-oldest.
- Proxy roots for curated safe globals (navigator/screen/document/…).
- Descriptor patches for `WATCHED_PROTOTYPES`.
- Sink wrappers: fetch, XHR, sendBeacon, WebSocket, EventSource,
  Worker, SharedWorker, image-src, script-src, navigation,
  importScripts.
- Dynamic-exec wrappers: eval, Function, setTimeout/setInterval-string.
- Introspection mask: Function.prototype.toString.
- Drain channel installed BEFORE other sections so it survives
  per-section failures.
- Snapshot-determinism tested.

### Phase 2 — Playwright driver + report merging

- `attach(context, opts)` returns a `Session` with `report()`, `cursor`,
  `detach()`, `trapScriptSha256`.
- `run(opts)` launches Chromium, attaches, navigates, drains, shuts
  down.
- `requestfinished` listener captures every JS-shaped response.
- Per-page event drain via `page.evaluate(name => window[name].drain(since), channelName)`
  (channel name is random per-build by default — see Phase 7).
- Reconstruction into `RawAccess[]`/`NetworkSink[]`/`DynamicHazard[]`.
- Static + runtime merge with provenance tagging.
- Per-script `trapCoverage` metric.
- e2e tests against real Chromium pass.

### Phase 3 — Dynamic-execution recursion

- eval / Function / setTimeout-string source captured at runtime.
- Driver sha256-hashes the captured source, persists as a synthetic
  `ScriptAnalysis` with `acquisition: "eval"` (or `function-ctor`,
  `settimeout-string`).
- Recursive `analyze()` runs on the captured source.
- `EVAL_RECURSION_DEPTH = 10` cap to defeat eval bombs.

### Phase 4 — Proxy roots + Reflect / descriptor

- Curated `PROXY_SAFE` whitelist avoids invariant violations.
- Chained-return Proxying for canvas/audio/webgl/webgpu contexts.
- Worker / SharedWorker constructors captured as sinks (worker-internal
  trap re-injection deferred — see "Out of scope" below).
- Reflect.get hijack is intentionally disabled by default (the noise
  cost outweighs benefit for current detector targets).

### Phase 5 — Anti-anti-debug + introspection defense

- `Function.prototype.toString` masking via a `WeakMap` from wrapped
  function → original source string.
- CDP `Debugger.setSkipAllPauses(true)` applied per-page via
  `context.on("page")`.
- Timer-noise neutralization parameterized but off by default.

### Phase 6 — Renderer + docs + contributor files

- `renderRuntimeText(report, opts)` extends static `renderText` with:
  - provenance column on every finding
  - per-script `trapCoverage` table
  - runtime-only / static-only gap blocks
- `s2b` CLI dispatches static / dynamic / harness / static-from-URL.
- GitHub Actions: `ci.yml` (typecheck + unit + e2e + docs build),
  `pages.yml` (Jekyll → GitHub Pages).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, issue and
  PR templates.
- `scripts/prepare-publish.mjs` swaps `file:` dep before `npm publish`.
- `scripts/export-schema.mjs` generates `docs/reportSchema.json`.
- Static `script2builtins` package brought to the same standard.

### Phase 7 — Audit fixes + driver/trap hardening

Triggered by a deep gap audit across both packages. Resolved:

- **Runtime leak detection wired.** `toNetworkSinks` now feeds
  `body.preview` through `parseRuntimeBody` in the static package so
  `summary.leakedApiCount` populates for runtime sinks (previously
  always 0).
- **Static-side hardening.** `safeDecode` wraps `decodeURIComponent`
  to keep a malformed URL escape from aborting analysis; SpreadElement
  handling in object literals; `new URLSearchParams("k=v&k=v")` and
  `[["k","v"],…]` init forms now traced.
- **Driver-side hardening.** `bufferOverflowsByKind` breakdown;
  `harnessMode` flag with `"data" | "file" | "http-harness"` (HTTP
  mode runs an ephemeral localhost server for a real origin); CLI
  numeric-arg validation; `buildHarnessHtml` rewritten to embed via
  `<script src="data:…">` (no more `</script>` escape racing).
- **Trap-side hardening.** Per-build random channel name
  (`__s2b_<6 hex>`) surfaced on `Session.channelName`; every wrapper
  registration routed through `registerWrapper`; opt-in
  `trapReflectGet` flag for `Reflect.get` introspection trampolines.

### Phase 8 — Coverage expansion

Closes the two biggest deferred-coverage items (OOS-1 and srcdoc):

- **`trapWorkers` (default on)** — classic `new Worker(url)`
  constructors are rewritten to bootstrap the trap inside worker
  scope via `importScripts(<trap blob>)`. Module workers and
  `SharedWorker` still pass through (documented limitation).
- **srcdoc iframe capture** — driver walks `iframe[srcdoc]`
  attributes and pulls `<script>` bodies through `extractScriptBodies`;
  new acquisition type `"srcdoc"` and `summary.srcdocScripts`.

### Phase 9 — Operator-Synthesis-era coverage

The [SoK on web-bot detection (USENIX Security 2024)] re-grouped the
landscape around what they call **Operator-Synthesis**: detectors that
no longer compare a fingerprint vector to a known-bad list, but
synthesize a per-session expectation from the *trace* of API calls —
ordering, timing, cross-API consistency — and classify deviations.
Phase 9 is the slice of work that re-tools the runtime around that
paradigm shift instead of chasing per-detector compatibility.

This phase is **tracking, not exit-criteria-bound**. The items below
are the lookout list. They're delivered piecemeal through the
top-level `ROADMAP.md` phases (mostly Phase 1 and Phase 4) — Phase 9
is the lens, not the schedule.

| Item | What | Lens |
|------|------|------|
| **D1**  | Trap survivability — mask `Error.prepareStackTrace`, hide `getStack`'s own frame. | A trace classifier that can see the trap frames trivially partitions sessions into "instrumented / not". |
| **D2**  | `trapReflectGet` on by default with a `node_modules`-shaped noise filter. | Operator-Synthesis detectors look for *fingerprint paths* that bypass the Proxy. Reflect.get is the most common bypass. |
| **D7**  | `postMessage` / `MessageChannel` sink kind. | Cross-realm telemetry is the canonical SoK exfil-channel; we missed it pre-Phase 4. |
| **D8**  | SubtleCrypto digest/sign capture. | Detectors hash fingerprint blobs *before* exfil; without the input bytes the hash is a black box. |
| **D13** | Function.toString shape audit against CreepJS-class probes. | Operator-Synthesis classifiers correlate `toString.length`, descriptor flags, own keys — any single-bit divergence is detectable. |

Out of scope for Phase 9, deliberately:

- **Trace-level latency masking.** See [`docs/limits.md`] §7 — the
  trap leaves wall-clock cost intact and is therefore visible to any
  classifier that includes per-call latency as a feature. This is a
  research-grade toolkit, not a stealth one.
- **Per-call-ordering replay.** Cataloging probe order is interesting
  forensically; reproducing a session against a different detector is
  out of scope.

[SoK on web-bot detection (USENIX Security 2024)]: https://www.usenix.org/conference/usenixsecurity24/presentation/azad
[`docs/limits.md`]: ./docs/limits.md

---

## Out of scope (intentional deferrals)

Carried forward to future versions. Each has a one-line rationale.
Resolved items keep their entry so the history is legible.

| ID    | Item                                          | Status   | Notes |
|-------|-----------------------------------------------|----------|-------|
| OOS-1 | Worker-internal trap re-injection             | ✅ Phase 8 | Classic `new Worker(url)` now boots via `importScripts(<trapBlob>)`. Module workers and `SharedWorker` still pass through — see `docs/limits.md`. |
| OOS-2 | Firefox / WebKit via Playwright               | Open     | Trap script is Chromium-tested only; some Proxy semantics differ. Add when there's a user request. |
| OOS-3 | Push-based drain via `page.exposeBinding`     | Open     | Pull-based works for current detector targets; switch when buffer overflows become common (now visible per-kind in `summary.bufferOverflowsByKind`). |
| OOS-4 | Reflect.get hijack opt-in                     | ✅ Phase 7 | `trapReflectGet` config flag + `--trap-reflect-get` CLI flag; default off. |
| OOS-5 | Harness HTTP fallback                         | ✅ Phase 7 | `harnessMode: "http-harness"` runs an ephemeral localhost server so the page has a real `http://` origin. |
| OOS-6 | `--verbose` debug channel                     | Implemented in v1; UI polish ongoing. |
| OOS-7 | Browser-extension content_script packaging    | Open     | Out of scope for v1; trap is self-contained so this remains a quick port. |
| OOS-8 | npm workspaces / monorepo                     | Open     | Sibling repos with `file:` link + `prepare-publish.mjs` work. Move to a monorepo if churn becomes painful. |
| OOS-9 | Module workers + SharedWorker bootstrap       | Open     | Module workers need `import` (not `importScripts`); SharedWorker bootstrap is browser-version-sensitive. |
| OOS-10| Channel-name randomization                    | ✅ Phase 7 | `__s2b_<6 hex>` per build; `Session.channelName` exposes it. |
| OOS-11| Per-kind buffer-overflow visibility           | ✅ Phase 7 | `summary.bufferOverflowsByKind`. |

---

## Open design questions

Carried over from the original review. Closed where the implementation
forced a decision; the remainder are deliberate deferrals.

1. **Drain transport** — Closed. Pull-based. Per-kind overflow
   visibility lets us judge when to switch.
2. **Worker / SharedWorker / ServiceWorker traps** — Partly closed.
   Classic `Worker` covered (Phase 8); SharedWorker and module
   workers still pass-through. ServiceWorker has its own lifecycle
   and remains open.
3. **CDP vs in-page** — Closed. In-page everywhere, CDP only for `Debugger.setSkipAllPauses`.
4. **Catalog version pinning** — Closed. `catalogVersion()` reads the static pkg's package.json at runtime; semver in deps via `prepare-publish.mjs`.
5. **Other browsers** — Open. OOS-2.
6. **Reflect.get coverage** — Closed (opt-in). OOS-4.
7. **Harness origin** — Closed. Three modes now: `data`, `file`,
   `http-harness`. OOS-5.
8. **Channel-name predictability** — Closed. Per-build random
   `__s2b_<6 hex>` is now the default. OOS-10.

---

## Release checklist

Before tagging a release:

- [ ] `npm test` clean (both packages)
- [ ] `npx tsc -p tsconfig.json` clean
- [ ] `CHANGELOG.md` updated with the new version
- [ ] `package.json` version bumped (SemVer per `docs/design-review.md`)
- [ ] If publishing: `node scripts/prepare-publish.mjs <range>`
- [ ] `git tag v<version>` and `npm publish`
- [ ] Revert `package.json` `script2builtins` dep back to `file:..` for dev
