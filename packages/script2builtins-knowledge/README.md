# script2builtins-knowledge

Shared API catalog for the [`script2builtins`](https://github.com/StackedQueries/script2builtins) family. Consumed by both:

- [`script2builtins`](https://github.com/StackedQueries/script2builtins/tree/master/packages/script2builtins) — static AST analyzer.
- [`script2builtins-runtime`](https://github.com/StackedQueries/script2builtins/tree/master/packages/script2builtins-runtime) — Playwright-driven dynamic analyzer.

Ships independently so catalog updates don't require a static-analyzer release.

## What's exported

- `ALL_APIS: ApiDefinition[]` — every fingerprinting / bot-detection API entry, aggregated across category files (`navigator`, `canvas`, `webgl`, `audio`, `webrtc`, `timing`, `intl`, `headless-tells`, `introspection`, `storage-fonts`, `media-permissions`, `media-capabilities`, `sensors`, `events-dom`, `speech`, `math`, `css-style`, `svg`, `workers`, `wasm`, `console`, `extensions`, `window-screen`, `document`).
- Per-category arrays: `navigatorApis`, `canvasApis`, etc., for callers that want one slice.
- `watchedRoots(apis?)` — the leftmost-identifier set used by the static analyzer to know which AST roots warrant catalog matching.
- `knownEndpoints`, `classifyEndpointUrl(url)`, `classifyEndpointPayloadKeys(keys)` — heuristic endpoint classifier (Botguard / DataDome / reCAPTCHA / Turnstile / etc.) and a `KnownEndpoint` type.
- Catalog-shape types: `ApiDefinition`, `Severity` (`"info" | "low" | "medium" | "high"`), `SokLayer` (`"L1a" | "L1b" | "L2" | "L3" | "L4"`).

## Install

```bash
npm i script2builtins-knowledge
```

## Usage

```ts
import { ALL_APIS, watchedRoots, classifyEndpointUrl } from "script2builtins-knowledge";

console.log(`Catalog: ${ALL_APIS.length} entries`);
console.log(`Roots:   ${watchedRoots().size}`);
console.log(classifyEndpointUrl("https://www.google.com/recaptcha/api2/anchor"));
```

## SoK layer taxonomy

Entries optionally carry a `layer` tag (Abel 2024 SoK on anti-automation):

| Layer | Class |
|---|---|
| `L1a` | Static environmental introspection (UA, screen, plugins) |
| `L1b` | Behavioral biometrics (mouse curves, keystroke dynamics) |
| `L2`  | Obfuscation / source-integrity checks |
| `L3`  | Execution traps (anti-logger, anti-debug, console hooks) |
| `L4`  | Chronometric integrity (timing-delta, clock-skew probes) |

When a per-entry `layer` is omitted, the aggregator backfills with the category default; see `CATEGORY_DEFAULT_LAYER` in `src/index.ts`.

## License

MIT.
