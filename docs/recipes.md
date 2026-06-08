---
title: Recipes
nav_order: 5
---

# Recipes

Short snippets for common reverse-engineering and security-research
workflows. `s2b` decides between static and dynamic mode by what you
give it — see the table on [the home page](./) for the dispatch rules.

## Pick a mode

```sh
# I have a JS file on disk — just read it
s2b detector.js

# I have a JS file, but the static pass is hitting eval/dynamic-key
# walls. Wrap it in a harness and let the browser execute it.
s2b detector.js --dynamic

# I have a live URL and want the full picture
s2b https://target.example/

# I have a URL but only want the source as it sits on the wire
s2b https://target.example/fp.js --static-only
```

## Run against a single URL and read the summary

```sh
s2b https://target.example/
# → runs/2026-05-13.../{ summary.txt, report.json, scripts/*.js }
```

The headline output is `summary.txt`. Each row starts with `★` if the
script tripped any bot-detection tells or leaked any cataloged API in
a sink payload.

## "What does this detector phone home with?"

```sh
s2b https://target.example/ --json | jq '
  .reconstructedSinks
  | map(select(.payload.leakedApis | length > 0))
  | .[] | {
      url, method,
      leaked: [.payload.leakedApis[].key],
      bodyPreview: .snippet[0:200],
    }
'
```

Every sink whose body carries a cataloged fingerprint surface is
listed with the API keys it leaks and a 200-character body preview.

## "Which surfaces did the page touch that the static pass missed?"

```sh
s2b https://target.example/ --json | jq '.summary.runtimeOnlyKeys'
```

This is the eval-blob delta plus anything reached through
`Reflect.get` / descriptor trampolines / dynamic keys. If the list is
empty, the static pass had complete coverage; if it's large, the
detector is heavily obfuscated and your reverse-engineering has to
start from the runtime side.

## "What does the eval blob actually contain?"

```sh
s2b https://target.example/ --json \
  | jq '.scripts[] | select(.acquisition == "eval") | .name'
```

Each eval'd payload is captured as a synthetic script
(`acquisition: "eval"`) and statically analyzed. Find the interesting
one, then read its per-script report:

```sh
cat runs/<runId>/scripts/<hash>_eval-from-<frame>.js.report.txt
```

## "Diff two runs to see what changed in the detector"

The detector ships updates without warning. Save reports per run and
diff them:

```sh
s2b https://target.example/ --out runs/today
# ... a week later ...
s2b https://target.example/ --out runs/today-plus-7

jq -r '.findings[] | .api.key' runs/today/report.json | sort -u > today.keys
jq -r '.findings[] | .api.key' runs/today-plus-7/report.json | sort -u > later.keys
diff today.keys later.keys
```

New keys appearing on the right side are surfaces the detector added.
Keys disappearing are surfaces it deprecated or moved to a different
slot.

## "Run against a HAR file instead of a live URL"

Sometimes you can't (or shouldn't) hit the live origin. Replay from a
saved HAR:

```sh
s2b --har capture.har --base-url https://target.example/
```

The driver replays responses from the HAR. The trap script still runs
in the live browser, so dynamic execution traces are real.

## "Pin to a specific Chrome major version"

Detectors discriminate by `navigator.userAgent` and `userAgentData`.
To match a specific version:

```sh
s2b https://target.example/ \
  --ua "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
```

## "Run inside CI without a display"

```sh
HEADLESS=1 s2b https://target.example/ --out artifacts/
```

A headless run will produce identical reports for most detectors; a
small number sniff `outerHeight === 0` and refuse to execute. For
those, use `xvfb-run` and drop `HEADLESS=1`.

## "Run a local detector blob with a real http:// origin"

`s2b detector.js --dynamic` defaults to a `data:` URL harness. That
gives the page an opaque origin — `localStorage`, cookies, same-origin
`fetch`, and `IndexedDB` behave differently than on a real site. Some
detectors care. Use `--harness-mode http-harness` to run an ephemeral
localhost server:

```sh
s2b detector.js --dynamic --harness-mode http-harness
```

`file` mode is also available if you only need disk-relative imports
to resolve.

## "Catch surfaces reached only through Reflect.get / non-Proxy refs"

A small number of detectors grab a pristine `navigator` reference
before our trap installs (race or `Object.getOwnPropertyDescriptor`
trick) and then call `Reflect.get(realNavigator, "userAgent")`. By
default we don't trap `Reflect.get` (it's hot in engine internals).
Turn it on for a single forensic run:

```sh
s2b https://target.example/ --trap-reflect-get
```

The extra `via: "reflect"` access events will show up in
`reconstructedAccesses` and feed `runtimeOnlyKeys` alongside the
existing Proxy paths.

## "Confirm classic-worker scripts were instrumented in-scope"

The driver bootstraps the trap inside every classic `new Worker(url)`
by default. To verify:

```sh
s2b https://target.example/ --json \
  | jq '.scripts[] | { name, acquisition, trapCoverage }'
```

Workers that ran the trap will have `acquisition: "network"` with
non-zero `trapCoverage`. If a worker shows `trapCoverage: 0` but ran
sinks, suspect it's a module worker or `SharedWorker` (the trap skips
those — see [Limits](limits.html#2b-worker-scope-coverage)).

## "Use as a library inside a larger pipeline"

```ts
import { run, renderRuntimeText } from "script2builtins-runtime";

const report = await run({
  url: "https://target.example/",
  outDir: "./runs/automated",
  headless: true,
});

const text = renderRuntimeText(report, { minSeverity: "medium" });
console.log(text);

for (const f of report.findings) {
  if (f.provenance === "runtime" && f.api.botDetectionTell) {
    console.log("RUNTIME-ONLY TELL:", f.api.key, f.callSites, "sites");
  }
}
```
