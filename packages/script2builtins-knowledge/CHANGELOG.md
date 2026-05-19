# Changelog

All notable changes documented per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
project follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial catalog smoke-test suite (`test/catalog.test.ts`) — asserts
  `ALL_APIS` is non-empty, every entry is well-formed, `(key + argMatch)`
  pairs are unique, `watchedRoots()` covers every non-wildcard root,
  `knownEndpoints` is populated, and `classifyEndpointUrl` returns
  `null` for unknown hosts.
- Package-level `README.md` and `LICENSE`.

## [0.1.0] — initial release

### Added

- `ALL_APIS` — aggregated catalog of ~460 fingerprinting / bot-detection
  API entries across navigator, window/screen, document, canvas, webgl,
  audio, webrtc, timing, intl, headless-tells, introspection,
  storage/fonts, media-permissions, media-capabilities, sensors,
  events/dom-layout, speech, math, css, svg, workers, wasm, console,
  extensions.
- Per-category arrays: `navigatorApis`, `canvasApis`, etc.
- `watchedRoots(apis?)` — leftmost-identifier set used by the static
  analyzer to know which AST roots warrant catalog matching.
- `knownEndpoints`, `classifyEndpointUrl`, `classifyEndpointPayloadKeys`
  — endpoint classifier with `KnownEndpoint` type.
- Catalog-shape types: `ApiDefinition`, `Severity`, `SokLayer`.
- Category-level default SoK layer backfill via `CATEGORY_DEFAULT_LAYER`
  in `src/index.ts`.
