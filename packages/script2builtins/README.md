# script2builtins

Forensic static analyzer for bot-detection / browser-fingerprinting JavaScript.

You feed it a script (a curl dump of `https://detector.example/check.js`, a
Puppeteer/Playwright page-source capture, an Akamai/DataDome/PerimeterX/Cloudflare
blob, anything) and it tells you:

1. **Which JS builtins and browser APIs the script touches** — grouped by
   fingerprint category, with a per-API note on what detectors are inferring
   and how the surface is typically defended.
2. **Where the script ships data** — every `fetch`, `XMLHttpRequest`,
   `navigator.sendBeacon`, `WebSocket`, image/script `src`, etc., with the
   resolved URL and HTTP method.
3. **What it ships** — for each sink, a static trace of the request body
   (object literal, `JSON.stringify`, `FormData` accumulator, URLSearchParams,
   query string), mapping each key back to the cataloged fingerprint
   surface that produced its value.

The intent is to make the surface area of an opaque detector legible in seconds
so you can reason about which axes need to be patched on the automation side
and exactly which values land in the detector's backend.

> **Want dynamic analysis too?** The companion package
> [`script2builtins-runtime`](https://github.com/StackedQueries/script2builtins/tree/main/packages/script2builtins-runtime)
> drives a real browser, traps every catalog API + sink + dynamic-execution
> point, and emits findings in the same shape the static analyzer here
> produces. The two compose into one unified report.

## Install

```sh
npm install -g script2builtins
# or as a library
npm install script2builtins
```

Requires Node 20+.

## CLI

```sh
script2builtins detector.js
script2builtins examples/*.js --min-severity medium
curl -sL https://example.com/fp.js | script2builtins -
script2builtins detector.js --json | jq '.findings[] | select(.api.botDetectionTell)'
```

### Curl recipes

Pipe a detector straight from the wire into the analyzer — no temp file:

```sh
# Plain text report from a remote script
curl -sL https://example.com/fp.js | script2builtins -

# Save the script and the report side-by-side
curl -sL https://example.com/fp.js -o fp.js && script2builtins fp.js > fp.report.txt

# Strip ANSI for a clean log
curl -sL https://example.com/fp.js | script2builtins - --no-color > fp.report.txt

# JSON output, then pluck the high-severity tells
curl -sL https://example.com/fp.js | script2builtins - --json \
  | jq '.findings[] | select(.api.severity == "high")'

# Just the network sinks (great for "what does it phone home with?")
curl -sL https://example.com/fp.js | script2builtins - --sinks-only --json \
  | jq '.networkSinks[] | {kind, method, url, leaked: .payload.leakedApis}'

# Follow a redirect chain and unzip a gzipped blob in one go
curl -sL --compressed https://detector.example/check.js | script2builtins -

# Send a Referer / UA so the origin actually serves you the script
curl -sL -H 'Referer: https://target.example/' \
        -H 'User-Agent: Mozilla/5.0' \
        https://detector.example/check.js | script2builtins -

# Pull a script out of an HTML page with curl + a quick extractor
curl -sL https://target.example/ \
  | grep -oE 'https://[^"]+\.js' | head -1 \
  | xargs curl -sL | script2builtins - --min-severity medium
```

Flags:

| flag | what |
|---|---|
| `--json` | machine-readable report |
| `--min-severity high\|medium\|low\|info` | filter findings (default info) |
| `--category navigator,canvas,...` | restrict to categories |
| `--no-hits` | hide source-evidence rows |
| `--max-hits N` | cap evidence rows per finding (default 5) |
| `--include-unknown` | also emit accesses we extracted but did not catalog |
| `--no-color` | strip ANSI |
| `--source-type script\|module` | force parse mode |
| `--no-sinks` | hide the network-sinks section |
| `--sinks-only` | print only sinks + summary (great for `\| jq`) |
| `--max-bytes N` | truncate each input to N bytes before parsing |
| `--parse-only` | only run the parser; emit a one-line ok/fail |

Exit code is `1` on parse failure, `2` on argument error, `0` otherwise.

## Library

The package ships fully-typed ESM. Top-level entry:

```ts
import { analyze, renderText, ALL_APIS } from "script2builtins";

const report = analyze(source, { name: "detector.js" });

console.log(renderText(report, { minSeverity: "medium" }));

for (const f of report.findings) {
  if (f.api.botDetectionTell) {
    console.log(f.api.key, "×", f.count, "—", f.api.evasion);
  }
}

// What does the detector actually send home?
for (const sink of report.networkSinks) {
  if (!sink.payload?.leakedApis.length) continue;
  console.log(sink.kind, sink.method, sink.url ?? sink.urlSnippet);
  for (const e of sink.payload.entries) {
    if (e.leakedApi) console.log(`  ${e.key} → ${e.leakedApi.key}`);
  }
}
```

### Subpath exports

You can pull individual layers if you want to compose your own pipeline
(custom AST source, swapped catalog, etc.):

| import path | what |
|---|---|
| `script2builtins` | top-level `analyze`, `renderText`, all types, and re-exports of `ALL_APIS` / `watchedRoots` / per-category exports |
| `script2builtins/analyze` | `parse`, `walkProgram`, `matchAccesses`, `scanSinks`, `tracePayload`, `parseRuntimeBody`, `buildAliases`, `buildValues`, `classifyValue`, `resolveChain`, `resolveStaticString` |
| `script2builtins/report` | `renderText`, `RenderTextOptions` |
| `script2builtins/types` | every type alias as a stand-alone import |
| `script2builtins-knowledge` | the catalog package itself — `ALL_APIS`, `watchedRoots`, per-category exports (`navigatorApis`, `canvasApis`, …). Use this directly when you only need the catalog. |

### Compose your own pipeline

```ts
import { parse, walkProgram, matchAccesses, scanSinks } from "script2builtins/analyze";
import { ALL_APIS, watchedRoots } from "script2builtins-knowledge";

const { program } = parse(source);
const { accesses, hazards, aliases } = walkProgram(program!, {
  source,
  watchedRoots: watchedRoots(ALL_APIS),
  snippetLength: 120,
});
const { findings } = matchAccesses(accesses, ALL_APIS);
const sinks = scanSinks(program!, aliases, { source, apis: ALL_APIS });
```

### Report shape ([full types](src/types.ts))

```ts
{
  source: { name, bytes, lines },
  parse:  { ok, sourceType, errors },
  findings: Finding[],          // matched API uses
  byCategory: Record<string, Finding[]>,
  hazards: DynamicHazard[],     // eval, Function, with, setTimeout-string, etc.
  networkSinks: NetworkSink[],  // every fetch/XHR/sendBeacon/WS/img-src/...
  unknownAccesses: RawAccess[], // only if includeUnknown: true
  summary: {
    totalAccesses, knownAccesses, botDetectionTells,
    fingerprintingDensityPerKb, categories,
    sinkCount, leakedApiCount,
  },
}
```

A `NetworkSink` carries `{ kind, url, method, headers, payload }`. The
`payload`, when present, gives you `{ shape, entries[], leakedApis[] }` —
each entry is a `key → sourceChain (or literal)` pair, and entries
whose `sourceChain` matches a cataloged API also carry a `leakedApi`
pointer. That's how you answer "which fingerprint surfaces does this
detector exfiltrate?" in one walk.

## Network sinks & exfiltration

What the analyzer detects:

| sink | how |
|---|---|
| `fetch(url, init)` | URL, method, headers, body — body run through the payload tracer |
| `XMLHttpRequest` | tracks `open` / `setRequestHeader` / `send` per instance and emits one `xhr` sink per `send` call |
| `navigator.sendBeacon(url, body)` | URL + body |
| `new WebSocket(url)` + `ws.send(data)` | one `websocket-open` plus one `websocket-send` per send call |
| `new EventSource(url)` | URL |
| `new Worker(url)` / `new SharedWorker(url)` | URL |
| `importScripts(url, …)` | one sink per URL argument |
| `new Image().src = url` / `createElement("img").src = url` | URL with query string parsed as a payload |
| `createElement("script").src = url` | URL |
| `location.href = url` / `location.assign(url)` / `location.replace(url)` | URL with query parsed |

Payload tracer covers:

- inline `JSON.stringify({ key: navigator.x, … })`
- `JSON.stringify(varName)` where `varName` was a tracked object literal
- object-literal spread (`{ ...{ a: navigator.x }, b }` flattens `a` in)
- `FormData.append/set` accumulators on a tracked variable
- `URLSearchParams` constructor — object init, query-string init
  (`new URLSearchParams("k=v&k=v")`), and array-of-pairs init
  (`new URLSearchParams([["k","v"],…])`)
- URL query strings (`?k=v&k=v`) parsed as literal entries — malformed
  percent-escapes are tolerated (analyzer falls back to raw bytes)
- single-property chain bodies (`fetch(url, { body: navigator.userAgent })`)

Each entry is matched against the API catalog; the union of matched
APIs becomes the sink's `leakedApis` set, and the report-level summary
deduplicates across sinks into `leakedApiCount`.

### Re-parsing a runtime-captured body

When you have a serialized request body (captured by a Playwright
trap, fetched from a request log, etc.) and want the same
`PayloadInfo` shape the AST tracer produces, use `parseRuntimeBody`:

```ts
import { parseRuntimeBody } from "script2builtins/analyze";
import { ALL_APIS } from "script2builtins-knowledge";

const payload = parseRuntimeBody(
  { shape: "json", preview: '{"userAgent":"…","webdriver":true}', truncated: false },
  ALL_APIS,
);
console.log(payload.leakedApis.map(a => a.key));
// → [ "navigator.userAgent", "navigator.webdriver" ]
```

Supported shapes: `string`, `json`, `urlsearchparams`, `formdata`,
`blob`, `binary`, `empty`. Nested JSON is flattened up to three
levels; a string body that looks like `k=v&k=v` is auto-detected as
urlencoded. This is the seam `script2builtins-runtime` uses to make
its runtime sinks populate `leakedApis` in the same way the static
pass does.

## Pointing it at a Botguard / Cloudflare / DataDome blob

The "30-second triage" the analyzer is built for is meant to look like
this. Suppose you've fetched a Botguard challenge into `bg.js`:

```sh
script2builtins bg.js --min-severity medium --no-hits
```

The report opens with a **verdict** line that fuses the structural
detectors and the provider classifier into one sentence — e.g.,
`Google Botguard blob (VM-class anti-bot — bytecode + dispatch
detected).` — followed by the summary block:

```
summary
  total accesses          312
  known fingerprint API   147
  bot-detection tells     54
  density (hits / KB)     32.5
  network sinks           3
  fingerprints exfiltrated 21
  anti-debug tells        9
  consistency checks      2
  VM bytecode detected    yes

layers (SoK)
  L1a static introspection     98
  L1b behavioral biometrics    11
  L2  source obfuscation        7
  L3  execution traps          18
  L4  chronometric integrity   13
```

Then come three blocks that answer the questions you actually have:

- **`structural findings`** — the VM-bytecode signature (B1), the
  chronometric / clock-skew probes (B2), the UA-vs-UA-CH and
  geometry-triangulation consistency checks (B3), and any
  cognitive-honeypot DOM constructions (A7).
- **`network sinks`** — every `fetch` / `XMLHttpRequest` /
  `sendBeacon` / `WebSocket` / `Image.src` outbound, with the resolved
  URL classified against the known anti-bot endpoint table (A6) so
  the `provider` field on each sink tells you whether the payload is
  going to Botguard, Cloudflare Turnstile, DataDome, Akamai, etc. The
  payload tracer maps each body key back to the cataloged surface that
  produced its value.
- **`dynamic hazards`** — `debugger;` traps, `eval` / `Function`
  variants (including `eval(atob(...))` style obfuscated-eval — B5),
  CPU-pause busy loops (B4), and `setTimeout`/`setInterval`
  with string arguments.

The **SoK layer block** lets you cross-walk the findings to the
academic literature directly — every cataloged entry that the
analyzer's category-default knows about carries an L1a/L1b/L2/L3/L4
tag derived from Abel's *SoK: Client-Side Anti-Automation After the
VLM*.

If you only care about exfiltration:

```sh
script2builtins bg.js --sinks-only --json | jq '
  .networkSinks[] | { kind, method, url, provider,
                       leaked: .payload.leakedApis | map(.key) }'
```

If you're triaging a 3MB Cloudflare blob and want to verify it parses
before paying the walk cost:

```sh
script2builtins big.js --parse-only --max-bytes 4000000
```

## What it catalogs

~460 entries across these categories (151 marked as strong
bot-detection tells):

- **navigator** — `userAgent`, `webdriver`, `plugins`, `languages`,
  `hardwareConcurrency`, `deviceMemory`, `userAgentData` (incl.
  `getHighEntropyValues`), `permissions`, `connection`, `mediaDevices`,
  `getBattery`, `gpu` (+ `requestAdapter` / `requestAdapterInfo`),
  `brave`, `userActivation`, `mediaCapabilities`, `requestMIDIAccess`,
  newer Chromium surfaces (`serial`/`hid`/`locks`/`scheduling`/
  `virtualKeyboard`/`wakeLock`/`share`/`contacts`), legacy
  IE/Firefox tells (`cpuClass`, `getVRDisplays`, `sidebar`), …
- **window / screen** — `outerWidth`/`outerHeight` (zero in headless),
  `chrome.runtime`, `chrome.loadTimes`, `visualViewport`, `screenX`/`Y`,
  multi-screen (`ScreenDetailed`, `getScreenDetails`), File System
  Access pickers, `crossOriginIsolated`, DPR, screen geometry
- **document** — `cookie`, `referrer`, visibility, `document.fonts`,
  `createElement`, `createRange`, `currentScript`, `styleSheets`,
  `adoptedStyleSheets`, `elementFromPoint` honeypots,
  iframe `contentWindow`/`contentDocument` cross-realm probes
- **canvas** — `getContext("2d")`, `toDataURL`, `toBlob`, `getImageData`,
  `fillText`, `measureText`, `TextMetrics.*BoundingBox*`,
  gradients, paths, `OffscreenCanvas`
- **webgl** — `getContext("webgl")`, `getParameter`, `getExtension` (with
  `WEBGL_debug_renderer_info`, `EXT_disjoint_timer_query`,
  `ANGLE_instanced_arrays`, compressed-texture extensions),
  `getSupportedExtensions`, `readPixels`,
  DRAWNAPART timer-query primitives (`createQuery`/`beginQuery`/
  `endQuery`/`getQueryParameter`), shader / draw / transform-feedback
- **webgpu** — `navigator.gpu`, `requestAdapter`, `requestAdapterInfo`
- **audio** — `AudioContext`/`OfflineAudioContext`/`webkitAudioContext`,
  `createDynamicsCompressor`, `createOscillator`, `createBiquadFilter`,
  `getChannelData`, `copyFromChannel`, `startRendering`, `baseLatency`,
  `outputLatency`, `sampleRate`, `maxChannelCount`, `AudioWorklet`
- **webrtc** — `RTCPeerConnection`, `createDataChannel`,
  `createOffer`/`createAnswer`, `setLocalDescription`,
  `RTCRtpSender.getCapabilities` / `RTCRtpReceiver.getCapabilities`
- **timing** — `performance.now`, `performance.memory`,
  `measureUserAgentSpecificMemory`, `getTimezoneOffset`, `Date`
  surfaces (`toString`, `parse`), `requestAnimationFrame`
- **intl** — `Intl.DateTimeFormat`/`NumberFormat`/`Collator`/
  `DisplayNames`/`ListFormat`/`PluralRules`/`RelativeTimeFormat`/
  `Locale`/`Segmenter`, `resolvedOptions`, `formatToParts`
- **speech** — `speechSynthesis`, `getVoices`, `onvoiceschanged`
- **math** — precision-sensitive `Math.acos`/`atan`/`tan`/`sin`/
  `cos`/`atanh`/`expm1`/`log1p`/… used to fingerprint engine math libs
- **headless-tells** — `$cdc_…`, `__webdriver_*`, `__pwInitScripts`,
  `__puppeteer_evaluation_script__`, `callPhantom`, `_phantom`,
  `__nightmare`, `domAutomationController`, Node leaks (`Buffer`,
  `process`, `require`, `module`, `global`), `Selenium`/`webdriver`
  global, prototype-side `outerHeight` probe
- **introspection** — `Function.prototype.toString` (used to detect
  monkey-patches), double-toString trick, `__lookupSetter__`/
  `__lookupGetter__`, `eval.toString` length (engine signature),
  `Object.getOwnPropertyDescriptor`, `Error.prepareStackTrace`,
  `Reflect.*`, `Proxy`, `Symbol.toStringTag`
- **storage / fonts** — `localStorage`, `indexedDB`, `indexedDB.databases`,
  `caches.keys`, `document.fonts.check`, `FontFace`
- **media / permissions / crypto / media-capabilities** —
  `enumerateDevices`, `canPlayType`, `MediaRecorder.isTypeSupported`,
  `MediaSource.isTypeSupported`, `MediaCapabilities.decodingInfo` /
  `encodingInfo`, `permissions.query`, `Notification.permission`,
  `crypto.*`
- **sensors** — `DeviceMotionEvent`, `DeviceOrientationEvent`, `TouchEvent`,
  full Generic Sensor API (`Gyroscope`, `Accelerometer`, `Magnetometer`,
  `LinearAccelerationSensor`, `GravitySensor`, `AbsoluteOrientationSensor`,
  `RelativeOrientationSensor`)
- **events / dom-layout** — `addEventListener` (mouse/touch/devicemotion
  classifiers), `Event.isTrusted`, `PointerEvent.pressure`/`tilt*`,
  `MouseEvent.movement*`, `getBoundingClientRect`, `getClientRects`,
  `elementFromPoint`, observers (`Mutation`/`Intersection`/`Resize`/
  `Performance`/`Reporting`), `matchMedia`
- **css** — `getComputedStyle`, `CSS.supports`, `cssRules`,
  `inlineSize`/`blockSize` for font-metric inference
- **svg** — `getBBox`, `getComputedTextLength`, `getSubStringLength`,
  `getExtentOfChar` (font fingerprint paths that bypass canvas hooks)
- **workers** — `Worker`, `SharedWorker`, `ServiceWorker`,
  `OffscreenCanvas` (worker-side GPU probe), `importScripts`,
  `WorkerNavigator` (dual-realm spoof check)
- **wasm** — `WebAssembly.compile`/`instantiate`/`Module`/`Memory`/
  `Memory.grow` (page-size TLB tell), `SharedArrayBuffer`,
  `Atomics.wait`/`notify`/`load`/`store`/`add` (sub-µs timer primitives)

Each entry carries a severity, a description of what the API leaks, a
`botDetectionTell` flag for the strong indicators, and (where applicable)
an `evasion` note describing how that surface is patched in stealth
toolchains. See the [`script2builtins-knowledge`](../script2builtins-knowledge) package for the full catalog.

The catalog is sourced from CreepJS (live probe enumeration plus the
`abrahamjuliot/creepjs` source) and the academic literature in
`prescience-data/dark-knowledge` (notably 2022 AudioContext Browser
Fingerprinting, 2022 DRAWNAPART GPU fingerprinting, 2022 Browser-based
CPU Fingerprinting, 2020 Carnus / Fingerprinting in Style, 2020 Taming
the Shape Shifter, 2019 JavaScript Template Attacks, the 2019 Browser
Fingerprinting Survey).

## What it sees through

- **Aliases.** `var n = navigator; n.webdriver` → reported as
  `navigator.webdriver`. Multi-hop: `var n = navigator; var p = n.plugins;
  p.length` → `navigator.plugins`.
- **Computed string keys.** `navigator["userAgent"]`,
  `navigator["user" + "Agent"]`, and template literals.
- **String aliases.** `var k = "userAgent"; navigator[k]`.
- **Global stripping.** `window.navigator.x`, `self.navigator.x`,
  `globalThis.navigator.x` all collapse to `navigator.x`.
- **Argument matching.** `getContext("2d")` vs `getContext("webgl")` vs
  `getContext("webgpu")` are routed to different categories.
  `getExtension("WEBGL_debug_renderer_info")` is split out as the
  unmasked-renderer trick.

## Hazards

Anything that puts code beyond static reach is reported separately:

- `eval(...)`
- `Function(...)` / `new Function(...)`
- `setTimeout("string", ...)` / `setInterval("string", ...)`
- `with` blocks
- `document.write` / `document.writeln`
- Dynamic `import(...)`
- `debugger;` statements
- Chronometric probes: timing-delta (`performance.now() - perfStart > N`),
  clock-skew (`Date.now() - performance.now()`), CPU-pause (tight busy
  loop + `performance.now()` read)
- Obfuscated `eval`: `eval(atob(...))`, `new Function(String.fromCharCode.apply(null, ...))`,
  `eval(decodeURIComponent(escape(...)))`

If a script is heavy on these you should assume it is also probing surfaces
the static report cannot enumerate. Pair the report with a runtime hook
(e.g., `Object.defineProperty` traps on `navigator.webdriver`,
`HTMLCanvasElement.prototype.toDataURL`) to capture the full picture.

## What it cannot see

- Code that exists only inside `eval` / `Function` strings.
- Reflective access through fully dynamic keys (`obj[someExpression()]`).
  The access is still emitted with a `null` segment and `hasDynamicSegment:
  true`, but the API isn't matched.
- Properties read indirectly through `Reflect.get`, `Object.getOwnPropertyDescriptor(...).get.call(...)` patterns.

These limits are inherent to a static-AST approach. For full coverage you
need a runtime instrumentation layer; this tool is the cheap first pass
that tells you where to point it.

### Out of scope: transport-layer fingerprinting

TLS / JA3 / JARM / TCP-stack / OS-network fingerprinting is **deliberately
out of scope**. Those surfaces are only observable on the *server* side
(or by a passive observer on the wire) — there is nothing for a static
JS analyzer to read, because the script never touches them. If you need
to reason about those axes, pair this analyzer with a TLS-aware client
like [`curl_cffi`](https://github.com/yifeikong/curl_cffi),
[`tls-client`](https://github.com/bogdanfinn/tls-client), or
[`utls`](https://github.com/refraction-networking/utls). The papers in
`2015 - Network-based HTTPS Client Identification Using SSL TLS
Fingerprinting`, `2020 - TLS Fingerprinting Techniques`,
`2021 - JA3cury`, `2021 - JARM Randomizer`, and
`2023 - A Two-Step TLS-Based Browser fingerprinting approach` cover the
relevant detection theory.

## Programmatic catalog

```ts
import { ALL_APIS } from "script2builtins-knowledge";

for (const def of ALL_APIS) {
  if (def.botDetectionTell) console.log(def.key, def.severity, def.description);
}
```

## Why static analysis at all?

Because the alternative — instrumenting and running an arbitrary blob
from a hostile domain in your own browser — has obvious downsides, and
because once you can name the surfaces a detector cares about you can
target your runtime patches surgically rather than guess. A 5KB minified
detector usually probes 30+ APIs; reading the generated report is faster
than reading the script.

## Contributing

The catalog lives in the sibling `script2builtins-knowledge` package and is intentionally split per category so
new entries are a one-line PR. Each entry is `{ key, category, severity,
description, botDetectionTell?, evasion?, argMatch?, layer? }` — the
optional `layer` slot takes one of `L1a` / `L1b` / `L2` / `L3` / `L4`
from the SoK anti-automation framework (Abel 2024) and shows up in the
report's `layers (SoK)` summary block. Tests live in `test/`; `npm test`
runs the fast suite. Run `S2B_RUN_E2E=1 npm test` to also exercise the
real captured detector fixtures in `test/fixtures/captured/` (Cloudflare
Turnstile, DataDome, full reCAPTCHA challenge — refresh them with
`node scripts/fetch-fixtures.mjs`). See [`REFERENCES.md`](REFERENCES.md)
for the papers that anchor specific catalog entries and detectors.

## Disclaimer

This is a research and defensive-analysis tool. Use it on traffic you are
authorized to inspect: your own automation pipelines, security
engagements with proper scope, academic study of fingerprinting, or
public detector blobs that you've fetched. Don't use it to build
infrastructure that defrauds, abuses rate limits, or attacks third
parties.

## License

MIT
