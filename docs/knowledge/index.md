---
title: Catalog reference (knowledge)
nav_order: 1
---

# script2builtins-knowledge

`script2builtins-knowledge` is the **shared API catalog** at the center of
the toolchain. It is the single source of truth for *which* browser APIs
and JS builtins count as fingerprinting / bot-detection surfaces, and both
analyzers consume it:

- [`script2builtins`](../static/) — the static AST analyzer.
- [`script2builtins-runtime`](../runtime/) — the Playwright-driven dynamic
  analyzer.

It ships and versions independently, so adding or re-classifying catalog
entries doesn't require cutting a new analyzer release.

## What's exported

- **`ALL_APIS: ApiDefinition[]`** — every fingerprinting / bot-detection
  API entry, aggregated across the category files: `navigator`, `canvas`,
  `webgl`, `audio`, `webrtc`, `timing`, `intl`, `headless-tells`,
  `introspection`, `storage-fonts`, `media-permissions`,
  `media-capabilities`, `sensors`, `events-dom`, `speech`, `math`,
  `css-style`, `svg`, `workers`, `wasm`, `console`, `extensions`,
  `window-screen`, and `document`.
- **Per-category arrays** — `navigatorApis`, `canvasApis`, etc., for callers
  that want a single slice rather than the full catalog.
- **`watchedRoots(apis?)`** — the leftmost-identifier set the static analyzer
  uses to decide which AST roots warrant catalog matching (e.g. `navigator`,
  `screen`, `document`).
- **Endpoint classifier** — `knownEndpoints`, `classifyEndpointUrl(url)`,
  `classifyEndpointPayloadKeys(keys)`, and the `KnownEndpoint` type. A
  heuristic mapper that recognizes Botguard / DataDome / reCAPTCHA /
  Turnstile / and other detector endpoints.
- **Catalog-shape types** — `ApiDefinition`, `Severity`
  (`"info" | "low" | "medium" | "high"`), and `SokLayer`
  (`"L1a" | "L1b" | "L2" | "L3" | "L4"`).

## Install

```bash
npm i script2builtins-knowledge
```

Most users never install this directly — it comes in transitively with
either analyzer. Install it on its own only when you want to query or
extend the catalog programmatically.

## Usage

```ts
import { ALL_APIS, watchedRoots, classifyEndpointUrl } from "script2builtins-knowledge";

console.log(`Catalog: ${ALL_APIS.length} entries`);
console.log(`Roots:   ${watchedRoots().size}`);
console.log(classifyEndpointUrl("https://www.google.com/recaptcha/api2/anchor"));
```

## SoK layer taxonomy

Entries optionally carry a `layer` tag, following the Abel 2024 SoK on
anti-automation:

| Layer | Class |
|---|---|
| `L1a` | Static environmental introspection (UA, screen, plugins) |
| `L1b` | Behavioral biometrics (mouse curves, keystroke dynamics) |
| `L2`  | Obfuscation / source-integrity checks |
| `L3`  | Execution traps (anti-logger, anti-debug, console hooks) |
| `L4`  | Chronometric integrity (timing-delta, clock-skew probes) |

When a per-entry `layer` is omitted, the aggregator backfills it with the
category default (`CATEGORY_DEFAULT_LAYER` in `src/index.ts`).

## How the analyzers use the catalog

Both analyzers match observed accesses against `ALL_APIS` and attach the
matching `ApiDefinition` (with its `severity` and `layer`) to each finding.
For how the static side consumes the `ApiDefinition` contract, see the
static analyzer's [Catalog reference](../static/catalog.html); for the
runtime view, see the runtime's [Catalog reference](../runtime/catalog.html).
