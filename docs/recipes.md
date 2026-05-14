---
title: Recipes
nav_order: 6
---

# Recipes

Short snippets for common reverse-engineering workflows on
bot-detection / fingerprinting JavaScript. The CLI accepts files,
stdin (`-`), and multiple files at once; `--json` is the seam for
`jq` pipelines.

## Read a single script

```sh
script2builtins detector.js
```

Output is a coloured text report — bot-detection tells highlighted in
red, evasion notes in green, dynamic hazards listed separately. Add
`--no-color` for clean logs or pipes to `less`.

## Run against a remote script without a temp file

```sh
curl -sL https://example.com/fp.js | script2builtins -
```

The `-` signals stdin. Without it, when stdout isn't a TTY the CLI
implicitly reads stdin — fine for the common `curl | script2builtins`
pattern; pass `-` explicitly inside pipelines so the intent is clear.

```sh
# Save the script and the report side-by-side
curl -sL https://example.com/fp.js -o fp.js \
  && script2builtins fp.js > fp.report.txt

# Strip ANSI for a clean log
curl -sL https://example.com/fp.js | script2builtins - --no-color > fp.report.txt

# Follow a redirect chain and unzip a gzipped blob in one go
curl -sL --compressed https://detector.example/check.js | script2builtins -

# Send a Referer / UA so the origin actually serves you the script
curl -sL -H 'Referer: https://target.example/' \
        -H 'User-Agent: Mozilla/5.0' \
        https://detector.example/check.js | script2builtins -
```

## "What does this detector phone home with?"

```sh
script2builtins detector.js --json | jq '
  .networkSinks
  | map(select(.payload.leakedApis | length > 0))
  | .[] | {
      kind, method, url,
      leaked: [.payload.leakedApis[].key],
      bodyPreview: .payload.snippet[0:200],
    }
'
```

Every sink whose body carries a cataloged fingerprint surface, with
the API keys it leaks and a 200-character body preview. Pair with
`--sinks-only` to skip everything else:

```sh
script2builtins detector.js --sinks-only --json \
  | jq '.networkSinks[] | {kind, method, url, leaked: .payload.leakedApis}'
```

## "Just the bot-detection tells"

```sh
script2builtins detector.js --json \
  | jq '.findings[] | select(.api.botDetectionTell) | {key: .api.key, count, evasion: .api.evasion}'
```

Or filter on severity:

```sh
script2builtins detector.js --min-severity high
```

`--min-severity` filters the rendered report; for JSON you filter
yourself with `jq`. The `medium` cutoff is usually right — `low` and
`info` are noisy on any non-trivial script.

## "What dynamic execution is this thing doing?"

```sh
script2builtins detector.js --json | jq '.hazards | group_by(.kind) | map({kind: .[0].kind, count: length})'
```

Output looks like:

```json
[
  { "kind": "Function", "count": 4 },
  { "kind": "eval", "count": 2 },
  { "kind": "setTimeout-string", "count": 1 }
]
```

Heavy hazards mean the static report is a lower bound. Pair the
script with `script2builtins-runtime` for the rest:

```sh
s2b detector.js --dynamic --out runs/today
```

(See the runtime package's [recipes](https://github.com/yourorg/script2builtins-runtime/blob/main/docs/recipes.md).)

## "Diff two versions of a detector"

Detectors ship updates without warning. Save reports per version and
diff the cataloged keys:

```sh
script2builtins -- v1.js --json | jq -r '.findings[].api.key' | sort -u > v1.keys
script2builtins -- v2.js --json | jq -r '.findings[].api.key' | sort -u > v2.keys
diff v1.keys v2.keys
```

The runtime package has a more thorough version of this via
per-script sha256 hashes, but the static-key diff catches most
catalog-level changes (new surface probed, surface dropped).

## "Strip noise — only the navigator / canvas / webgl categories"

```sh
script2builtins detector.js --category navigator,canvas,webgl
```

`--category` accepts a comma-separated list (and lowercases for
matching). This is the report-time filter; the underlying
analysis sees everything.

## "Run on many files in one go"

```sh
script2builtins examples/*.js --min-severity medium
```

Files are separated by a row of `─` in text mode; in JSON mode
the output is an array of reports. Exit code is `1` if any file
fails to parse.

## "Just the structured data — pipe to a downstream tool"

```sh
script2builtins detector.js --json > report.json
```

The shape is the `Report` from [`src/types.ts`](https://github.com/yourorg/script2builtins/blob/main/src/types.ts).
Top-level fields you usually want:

- `findings[]` — sorted by severity, with hits and per-API
  `description` / `evasion`.
- `networkSinks[]` — sinks with traced payloads.
- `hazards[]` — dynamic-execution sites.
- `summary` — counts + categories + density.

Per-finding evidence is in `findings[].hits[]`; each `hit` has
`{ chain, snippet, loc, called, firstStringArg, … }`.

## "Use as a library inside a larger pipeline"

```ts
import { analyze, renderText, ALL_APIS } from "script2builtins";

const report = analyze(source, { name: "detector.js" });

// 1. Show the human report (no colour for log files)
console.log(renderText(report, { minSeverity: "medium", noColor: true }));

// 2. Programmatic checks
const tells = report.findings.filter(f => f.api.botDetectionTell);
if (tells.length > 0) {
  console.log("RED FLAGS:");
  for (const t of tells) console.log(" ", t.api.key, "×", t.count, "—", t.api.evasion);
}

// 3. Exfiltration audit
for (const sink of report.networkSinks) {
  if (!sink.payload?.leakedApis.length) continue;
  console.log(sink.kind, sink.url ?? sink.urlSnippet);
  for (const e of sink.payload.entries) {
    if (e.leakedApi) console.log("  ", e.key, "→", e.leakedApi.key);
  }
}
```

## "Plug into a pre-commit hook to scan vendored detector blobs"

```sh
#!/usr/bin/env bash
set -e
git diff --cached --name-only --diff-filter=ACM \
  | grep -E '\.js$' \
  | while read f; do
      hits=$(script2builtins "$f" --json | jq '.summary.botDetectionTells')
      if [ "$hits" -gt 0 ]; then
        echo "  ! $f: $hits bot-detection tells" >&2
        exit 1
      fi
    done
```

Useful when you're pulling third-party scripts into a vendored
directory and want a wall against accidentally landing a fingerprinter.

## "Compose your own pipeline"

When you want a piece of the analyzer but not the whole thing —
your own AST source, your own filter rules, or a custom catalog:

```ts
import { parse, walkProgram, matchAccesses, scanSinks } from "script2builtins/analyze";
import { ALL_APIS, watchedRoots } from "script2builtins/knowledge";

const { program } = parse(source);
const { accesses, hazards, aliases } = walkProgram(program!, {
  source,
  watchedRoots: watchedRoots(ALL_APIS),
  snippetLength: 120,
});
const { findings, unknown } = matchAccesses(accesses, ALL_APIS);
const sinks = scanSinks(program!, aliases, { source, apis: ALL_APIS });
```

Each piece is independent — swap any of them. The most common
override is a filtered catalog:

```ts
import { canvasApis, webglApis } from "script2builtins/knowledge";
const myCatalog = [...canvasApis, ...webglApis];
const { findings } = matchAccesses(accesses, myCatalog);
```

## "Re-parse a runtime-captured body"

When you have a saved request body (Playwright trap output, HAR
file, request log) and want the same `PayloadInfo` shape the static
tracer produces, use `parseRuntimeBody`:

```ts
import { parseRuntimeBody } from "script2builtins/analyze";
import { ALL_APIS } from "script2builtins/knowledge";

const payload = parseRuntimeBody(
  { shape: "json", preview: requestBody, truncated: false },
  ALL_APIS,
);
console.log(payload.leakedApis.map(a => a.key));
// → [ "navigator.userAgent", "navigator.webdriver", ... ]
```

Supported shapes: `string`, `json`, `urlsearchparams`, `formdata`,
`blob`, `binary`, `empty`. See [Payload tracer](payload-tracer.html#parseruntimebody)
for the matching tiers.

## "I have a HAR file — extract every JS body and analyze each"

```sh
jq -r '.log.entries[]
       | select(.response.content.mimeType | test("javascript"))
       | .response.content.text' capture.har \
  | while IFS= read -r line; do
      printf '%s\n' "$line" | script2builtins - --json
    done | jq -s '.'
```

Crude but works. For a more thorough pipeline use the runtime
package's `--har` mode, which replays the HAR through a real
browser.

## CLI flags reference

| flag                              | what                                                  |
|-----------------------------------|-------------------------------------------------------|
| `--json`                          | machine-readable report (array if multiple files)     |
| `--text`                          | force text output                                     |
| `--min-severity LEVEL`            | filter findings: `high\|medium\|low\|info` (default info) |
| `--category NAME[,NAME...]`       | restrict to categories                                |
| `--no-hits`                       | hide per-finding source-evidence rows                 |
| `--max-hits N`                    | cap evidence rows per finding (default 5)             |
| `--include-unknown`               | also emit accesses we extracted but did not catalog   |
| `--no-color` / `--no-colour`      | strip ANSI                                            |
| `--source-type script\|module`    | force parse mode (default: try module then script)    |
| `--no-sinks`                      | hide the network-sinks section                        |
| `--sinks-only`                    | print only sinks + summary                            |
| `-h`, `--help`                    | show help                                             |
| `-v`, `--version`                 | show version                                          |

Exit codes: `0` on success, `1` on parse failure, `2` on argument
error.
