# Changelog

All notable changes documented per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
project follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`parseRuntimeBody(body, apis)`** — new export on
  `script2builtins/analyze`. Re-parses a serialized request-body
  preview captured at runtime (the trap-side shape from
  `script2builtins-runtime`) into the same `PayloadInfo`
  `{shape, entries, leakedApis, snippet}` the static path produces.
  Handles `string` / `json` / `urlsearchparams` / `formdata` / `blob`
  / `binary` / `empty` shapes; flattens nested JSON up to three
  levels; falls back to urlencoded detection when a string body
  contains `k=v&k=v`.
- **`matchByLeafName` (internal, reachable via `parseRuntimeBody`)** —
  resolves a single-segment runtime entry key (e.g. `userAgent`) to a
  catalog API via a tiered preference rule: canonical `category.leaf`
  (length-2) > nested concrete > wildcard > bare global; skips
  `__proto__`-traversing entries.
- **`RuntimeBody` type** exported from `script2builtins/analyze` — the
  shape the runtime trap emits for each captured body.
- **`new URLSearchParams("k=v&k=v")` and `new URLSearchParams([["k","v"],…])`**
  init forms are now resolved by the payload tracer (previously only
  the object-literal form was handled).
- **SpreadElement in object payloads** — `{ ...{ a: navigator.x }, b: y }`
  no longer silently drops `a`; inline-object spreads splice their
  entries in. Identifier spreads (`{ ...captured, b }`) record an
  opaque marker so the resolver can follow them.

### Fixed

- **`decodeURIComponent` DoS** in `maybeQueryStringPayload`
  (`src/analyze/sinks.ts`) — a malformed percent escape in a URL
  query string used to throw `URIError` and abort analysis of the
  rest of the script. Wrapped in a `safeDecode` helper that falls
  back to the raw bytes on failure.

### Changed

- The `tracePayload` API is unchanged; the new entries above are
  additive. No breaking changes.

## [0.1.0] — initial release

### Added

- `analyze(source, opts)` — full pipeline that returns a `Report`.
- `parse`, `walkProgram`, `matchAccesses`, `scanSinks`,
  `tracePayload`, `buildAliases`, `buildValues`, `classifyValue`,
  `resolveChain`, `resolveStaticString` — composable lower-level
  pieces.
- ~460 catalog entries across navigator, window/screen, document,
  canvas, webgl, webgpu, audio, webrtc, timing, intl, headless-tells,
  introspection, storage/fonts, media/permissions/crypto, sensors,
  events/dom-layout, css, svg, workers, wasm.
- 151 entries marked as strong bot-detection tells.
- Network-sink discovery covering fetch, XHR, sendBeacon, WebSocket,
  EventSource, Image/script src, Worker/SharedWorker/ServiceWorker,
  importScripts, location navigations.
- Payload tracer for `JSON.stringify`, `FormData`, `URLSearchParams`,
  URL query strings, and single-property fetch bodies.
- `renderText(report)` — human-readable report with ANSI color.
- ESM-only, fully-typed, with subpath exports
  (`script2builtins/analyze`, `/knowledge`, `/report`, `/types`).
- CLI: `script2builtins <file>` plus stdin (`-`) and JSON output.
- Companion package [`script2builtins-runtime`](https://github.com/yourorg/script2builtins-runtime) provides the dynamic-analysis layer with the same report shape.
