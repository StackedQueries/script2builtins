---
title: Design review
nav_order: 8
---

# Design review

This is the design ledger for `script2builtins-runtime`. Decisions
live here with their reasoning so a future maintainer can read *why*
the code looks the way it does. New decisions append; existing ones
get an "amended" note rather than being rewritten.

The companion file is [`ROADMAP.md`](https://github.com/StackedQueries/script2builtins/blob/main/packages/script2builtins-runtime/ROADMAP.md)
at the package root — that one tracks phases, this one tracks principles.

---

## Principles

These are the design rules the codebase tries not to violate. When two
principles disagree, the one nearest the top wins.

1. **The catalog is the spec.** `ALL_APIS` in `script2builtins` is the
   single source of truth for what we trap. The runtime layer reads
   the catalog and generates traps. Adding a fingerprint surface is a
   one-line PR to the catalog; the runtime picks it up on next build.
2. **Same report shape, both modes.** A `RuntimeReport` is a strict
   superset of a static `Report`. Code that reads the static shape
   keeps working on the runtime shape. Provenance is an additive
   field, not a parallel structure.
3. **Pristine references at the trap script's top.** The very first
   thing the trap script does is capture references to `Object`,
   `Reflect`, `Proxy`, `Function.prototype.call`, `console`,
   `performance.now`, etc. Every subsequent line uses those
   references. A page that mutates `window.Object` after load
   cannot blind us.
4. **No matching in the trap script.** The trap script emits raw
   events (chain + first-string-arg + call/get). The Node-side driver
   runs the same `matchAccesses` the static pass uses. One matcher,
   one catalog, two event sources.
5. **Cursors over snapshots.** Reports are drained incrementally with
   a monotonic `seq` cursor. A long-running automation can pull a
   checkpoint after every meaningful interaction without re-reading
   the whole history.
6. **Open source legibility.** Each module has a one-paragraph header
   comment explaining its job. Public types carry doc comments. Magic
   strings and numeric constants get named symbols (`STACK_LIMIT`,
   `BUFFER_BYTE_CAP`, etc.).

---

## Decisions

### D-1. Single package, dispatched CLI {#d-1}

`script2builtins-runtime` depends on `script2builtins` and ships one
`s2b` binary. Static-only users can still install `script2builtins`
directly for its smaller footprint; users who want both install the
runtime package and get both.

**Rejected alternatives:**

- *Single package with playwright as a peerDep.* Confusing UX — the
  static install is "complete" but the dynamic CLI fails at first run
  unless playwright is also installed.
- *Monorepo with three packages.* Adds tooling weight; the seam
  between static and runtime is already clean.

**Trade-off:** the runtime package pulls Playwright as a regular
dep (~50 MB after `playwright install chromium`). Users who only want
static analysis should install `script2builtins`, not the runtime.

### D-2. `attach(context)` is the core primitive {#d-2}

The engine is bound to a `BrowserContext`, not a browser launch.
`run({ url })` is a convenience wrapper that launches Chromium, calls
`attach`, navigates, drains a final report, and shuts down.

**Why:** the "drop into existing Playwright automation" use case is
load-bearing. We can't take ownership of the browser when the user
already owns it.

**Implication:** every option that used to live on `RunnerOptions`
splits — `AttachOptions` (everything that's safe to apply to a
context you don't own) and `RunOptions` (everything `attach` accepts
plus browser-launch settings).

### D-3. `Session` handle with `.report({since, flush}) / .detach()` {#d-3}

`attach()` returns:

```ts
interface Session {
  report(opts?: { since?: number; flush?: boolean }): Promise<RuntimeReport>;
  cursor: number;
  detach(): Promise<void>;
}
```

- `since` — only events with `seq > since`. Cheap; no rescan.
- `flush` — drains the in-page buffer; durable per-script artifacts
  are written.

**Why two operations:** a long automation wants cheap checkpoints
between flows and a single durable flush at the end. Cursors give
both with one method.

### D-4. Discriminated unions, narrowly typed {#d-4}

The earlier scaffold had:

```ts
interface RuntimeEvent {
  kind: "access" | "sink" | "hazard" | "eval-source";
  // ...
}
interface RuntimeAccessEvent extends RuntimeEvent { kind: "access"; ... }
```

This is a smell — `RuntimeEvent` allows all four kinds, so
`event.kind === "access"` doesn't narrow to `RuntimeAccessEvent`
properly. Fix: the base interface omits `kind` entirely; each derived
type owns its discriminator.

```ts
interface RuntimeEventBase {
  seq: number;
  t: number;
  scriptUrl: string | null;
  scriptSha256: string | null;
  line: number | null;
  column: number | null;
  stack: string;
}
interface RuntimeAccessEvent extends RuntimeEventBase {
  kind: "access";
  chain: string[];
  // ...
}
```

This is what `0c-2` in the roadmap fixes.

### D-5. Hashing strategy {#d-5}

Three independent hash slots:

| Field                                  | Hashes                                  | Where it lives             |
|----------------------------------------|-----------------------------------------|----------------------------|
| `ScriptAnalysis.sha256`                | sha256 of source bytes                  | every captured script      |
| `RuntimeEvent.scriptSha256`            | sha256 of the *calling* script's source | every access / sink event  |
| `RuntimeReport.trapScriptSha256`       | sha256 of the injected trap script      | top-level report           |

**Why:**

- **Per-script hash.** Diffing two runs answers "did this script
  change between Tuesday and Wednesday?" — flip a regex match against
  the URL and a hash comparison, done. Same script served at the same
  URL with different bytes is the canonical detector-update signal.
- **Per-event scriptSha256.** Attributes runtime traces to a specific
  script version. Lets you say "this access fired from
  script@<sha>" so when the script changes, you can tell whether the
  trace is still valid.
- **Trap script hash.** Same diffing logic for the instrumentation
  itself. If two reports were produced by different trap scripts they
  may not be comparable; the hash makes that explicit.

**Resolution mechanism for `scriptSha256` (in-page side):**
the trap script can't compute sha256 cheaply. So in-page we record
`scriptUrl` only; the Node-side driver maintains a `Map<url, sha256>`
populated by the `requestfinished` listener and back-fills
`scriptSha256` during reconstruction. Inline scripts get the
DOM-extracted source hash. Eval'd scripts get the source-string
hash.

### D-6. No event duplication {#d-6}

The earlier scaffold had `ScriptAnalysis.runtimeEvents:
AnyRuntimeEvent[]` *and* `RuntimeReport.reconstructedAccesses:
RawAccess[]`. Same data, two storages. For a 1-hour automation with
50k events that's a serialization disaster.

**Resolution:** events live in one place. `RuntimeReport.events:
AnyRuntimeEvent[]` is the canonical list. `ScriptAnalysis` references
its events by `[startSeq, endSeq]` range — no copy.

`reconstructedAccesses` and `reconstructedSinks` stay, because those
are derived projections used by `matchAccesses`; they're cheaper than
re-projecting on every consumer read.

### D-7. Versioned report schema {#d-7}

Add `reportVersion: "1.0.0"` and `catalogVersion: "<pkg>@<semver>"` to
the top-level `RuntimeReport`. Increment `reportVersion` on any
breaking shape change. Downstream consumers can branch on it.

### D-8. Pull-based drain (provisional) {#d-8}

The Node side calls
`page.evaluate(({name,s}) => window[name].drain(s), { name: channelName, s: cursor })`
periodically and on report request (channel name is random per build;
see [D-16](#d-16)). Push-based via `page.exposeBinding` is faster for
chatty pages but adds two failure modes (binding dropped,
async-iteration ordering). Start pull, measure on real detector
targets, switch only if pull caps out. The Phase 7 per-kind overflow
breakdown ([D-17](#d-17)) gives the metric to make that call.

### D-9. Stack capture cost capped at the trap script {#d-9}

`new Error().stack` is the dominant per-event cost. Cap the captured
lines (`STACK_LIMIT = 8`) at the trap-script level. Parsing
URL/line/column is Node-side; the in-page side ships raw strings.

### D-10. Harness modes — `data:`, `file://`, `http://127.0.0.1` {#d-10}

`runHarness(file, { harnessMode })` supports three flavors:

| mode             | origin                | when to use |
|------------------|-----------------------|-------------|
| `data` (default) | opaque `data:`        | cheapest; the bytes are inline in the URL. Storage APIs behave differently from a real site. |
| `file`           | opaque `file://`      | want relative imports to resolve from disk. Same SOP caveats as `data:`. |
| `http-harness`   | real `http://127.0.0.1` | the script needs cookies, `localStorage`, or same-origin fetches. Spins an ephemeral localhost server per run. |

The HTML embeds the script via `<script src="data:text/javascript;base64,…">`
so the script body is opaque to the HTML tokenizer regardless of mode
— a previous version inlined the source and regex-escaped `</script>`,
which missed corner cases like `<!--<script>` (script-data-double-escaped
state) and whitespace-after-tag-name (`</script `).

The report records `harnessMode: "url" | "data" | "file" | "http-harness"`.

### D-11. `script2builtins` is a regular dep on a published version {#d-11}

`package.json` currently has `"script2builtins": "file:../script2builtins"`.
That works for local dev but breaks the moment the runtime is
published. Resolution:

- Pin to a real semver range (`"^0.1.0"`) before first publish.
- For local dev, document npm workspaces or `npm link`. (Workspaces
  preferred — see `0c-9`.)
- Once both packages are real npm packages, add a root
  `package.json` with `workspaces: ["packages/*"]` to make local
  dev one `npm install` away.

### D-12. Pre-existing pages aren't instrumented {#d-12}

Playwright's `addInitScript` only runs in frames created *after* it
was registered. If a user calls `attach(context)` when pages are
already open, those pages won't have traps.

**Resolution:** detect and report.
`session.report().summary.preExistingPages: number` carries the
count. Docs flag this prominently with a recipe:

```ts
// CORRECT
const context = await browser.newContext();
const session = await attach(context);    // attach before opening any page
const page = await context.newPage();

// WRONG (will warn)
const context = await browser.newContext();
const page = await context.newPage();      // page boots without traps
const session = await attach(context);
```

### D-13. Worker-side traps — classic done, module/shared deferred {#d-13}

Web Workers / SharedWorkers / ServiceWorkers have their own globals.
Trapping them requires reinjecting the script into each worker.

**Resolved for classic workers (Phase 8).** The driver publishes the
trap source as `globalThis.__s2bWorkerTrap` via a sibling
`addInitScript`. The main-thread trap wraps `new Worker(url)` to
construct a bootstrap blob:

```js
importScripts(<trap blob URL>);
importScripts(<original user URL>);
```

So the worker runs the trap before any user code. Worker scope only
has a subset of globals (no `Navigator`/`HTMLImageElement`/…) — the
trap's `typeof` guards make DOM-only sections silently no-op, while
sink wraps (`fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`)
remain active. Controlled by `trapWorkers` (default true).

**Deferred:**

- **Module workers** (`{ type: "module" }`) — use ES-module `import`,
  not `importScripts`. Bootstrap would need to construct a module
  with the trap as a top-level import; viable but not yet
  implemented.
- **`SharedWorker`** — `importScripts(<blob>)` in shared-worker
  scopes is browser-version-sensitive; risk of breaking the worker
  exceeds value at current detector targets.
- **`ServiceWorker`** — registered in a different lifecycle from the
  page; bootstrap requires intercepting the registration and
  rewriting the script URL, which collides with SW update logic.

### D-14. Renaming `s2b-runtime` → `s2b` (with alias) {#d-14}

The CLI is one tool with two modes, not two tools. Naming it `s2b`
makes that obvious. Keep `s2b-runtime` as an alias so anyone who
installs based on docs from a future blog post still gets a working
binary. Drop the alias in a 1.0 major release with a deprecation
notice.

### D-15. Runtime body re-parser lives in the static package {#d-15}

The runtime trap captures request bodies as a serialized preview
(`string` / `json` / `formdata` / `urlsearchparams` / `blob` /
`binary` / `empty`). Until Phase 7, `toNetworkSinks` in the runtime
package emitted these with `entries: []` and `leakedApis: []` — the
preview was on disk but the fingerprint surfaces inside it weren't
matched against the catalog. `summary.leakedApiCount` was always 0
for runtime sinks even when the body obviously contained
`navigator.userAgent`.

**Resolution:** `parseRuntimeBody(body, apis)` lives in
`script2builtins/analyze` (the package that already owns the payload
parser concept). It handles each runtime shape, flattens nested JSON
up to 3 levels, falls back to urlencoded detection on a `k=v&k=v`
string, and matches each entry's key against the catalog through a
new `matchByLeafName` helper (tiered preference: canonical
`category.leaf` > deeper concrete > wildcard > bare global; skips
`__proto__` chains).

The runtime side just calls it from `toNetworkSinks`. One matcher,
one catalog, two body sources — same principle as D-4 / D-5 for
accesses.

### D-16. Channel name is random per-build {#d-16}

V1 used a fixed `window.__s2bRt` for the drain channel. A page that
runs `if (window.__s2bRt) throw "instrumented"` could detect us by
name. Phase 7 changes the default to `__s2b_<6 hex bytes>` generated
at trap-build time. `Session.channelName` exposes the chosen value so
external code can drain manually. Explicit `channelName` override
remains for tests that need a stable name.

This isn't a complete defense — a page could enumerate `Object.keys`
or `Reflect.ownKeys` of `window` and recognize the `__s2b_` prefix.
But it's a much cheaper bar than allowing direct lookup, and a
future iteration can drop the prefix entirely.

### D-17. Buffer-overflow drops surface per-kind {#d-17}

The byte-cap event buffer uses drop-oldest on overflow. V1 reported
only the total drop count (`summary.bufferOverflows`). That number
alone can't tell you whether the buffer chewed up access spam (low
signal — usually fine, just raise the cap) or wiped out sink/hazard
events (high signal — missing exfiltration).

Phase 7 adds `summary.bufferOverflowsByKind: { access, sink, hazard }`.
The text renderer flags `sink`/`hazard` losses in red and prints a
hint to raise `bufferByteCap`.

---

## Smells caught in review

This section is the inventory of things flagged during the design
review and how they were resolved. New issues append.

### S-1. `script2builtins` `file:` dep (resolved → `D-11`)

`file:../script2builtins` in `package.json` will not work for an npm
install. Resolved by switching to a semver range pre-publish and
documenting workspaces for local dev. Task: `0c-9`.

### S-2. Discriminator on the base interface (resolved → `D-4`)

`RuntimeEvent.kind` allowed all four kinds, so narrowing didn't work.
Resolved by removing `kind` from the base. Task: `0c-2`.

### S-3. Duplicate event storage (resolved → `D-6`)

Events stored both globally and per-script. Resolved by storing once,
referencing by index range. Task: `0c-6`.

### S-4. `run()` owns the browser (resolved → `D-2`)

Made it impossible to use the engine inside an existing automation.
Resolved by making `attach(context)` the core primitive. Task:
`0c-1`.

### S-5. No script hashing (resolved → `D-5`)

Two reports across days couldn't be diffed cheaply. Resolved with the
three-slot hashing strategy. Tasks: `0c-3`, `0c-4`.

### S-6. No report version (resolved → `D-7`)

Downstream consumers had no way to branch on schema changes.
Resolved by adding `reportVersion` + `catalogVersion`. Task:
`0c-5`.

### S-7. Dynamic import inside `runHarness` (resolved → cleanup)

`runHarness` does `await import("./driver.js")` to avoid a circular
import. There is no circular import — it was an artifact of an earlier
design where the CLI did this for startup-latency reasons. Replace
with a direct top-level import. Task: `0c-8`.

### S-8. CLI dispatcher is one big function (deferred)

`parseArgs` in `src/cli.ts` is fine for the current eight flags but
will become hard to maintain past ~20. Split into `src/cli/parse.ts`
when it grows. Not a Phase 0c blocker.

### S-9. No verbose / debug mode (resolved → tasked)

Trap script debugging will be a nightmare without it. Resolved by
adding `--verbose` (Phase 2, `0c-14`) that forwards an in-page
`console.debug` channel to Node stderr.

### S-10. Unbounded event buffer (resolved → tasked)

Chatty pages could fill the in-page buffer with hundreds of MB before
a drain. Resolved by:

- Hard byte cap (`BUFFER_BYTE_CAP`, default 16 MB).
- Overflow policy: drop oldest with a counter recorded into the
  report (`summary.bufferOverflows`). Task `0c-12`.

### S-11. Harness `data:` URL size (resolved → tasked)

For files >1 MB, fall back to a local HTTP server. Task `0c-13`.

### S-12. `addInitScript` ordering (resolved → `D-12`)

Pre-existing pages aren't instrumented. Detect and report.

### S-13. No CI / contributing files (resolved → tasked)

Phase 6: `0c-16` (contributor files), `0c-17` (CI workflow),
`0c-18` (changelog).

### S-14. JSON schema (resolved → tasked)

`reportSchema.json` generated from TypeScript types so downstream
consumers in non-TS environments have a contract. Phase 6, `0c-10`.

### S-15. `trapCoverage` per script (resolved → tasked)

For each captured script, compute the fraction of cataloged surfaces
the runtime actually touched vs the static pass saw. Lets users see
which scripts had the largest static/runtime gap. Phase 2, `0c-11`.

---

## Versioning and release strategy

- **SemVer.** Pre-1.0 the surface is unstable; major bumps allowed on
  any release with a changelog note.
- **`reportVersion` is independent of package version.** A 0.5.0
  release that adds a new event field but doesn't break the existing
  shape still emits `reportVersion: "1.0.0"`.
- **Catalog updates are minor bumps.** `0.1.x → 0.2.0` when
  `ALL_APIS` adds a new category.
- **Pin policy.** The runtime package pins `script2builtins` to a
  tight range (`~0.1.0`) — the trap-script generator depends on the
  catalog shape, so a static-pkg minor that adds a new category
  requires a corresponding runtime release.

---

## Testing strategy

| Layer                          | Test type     | Location              |
|--------------------------------|---------------|-----------------------|
| Type shapes                    | typecheck     | `tsc --noEmit` in CI  |
| `buildTrapScript` determinism  | snapshot      | `test/trap/snapshot.test.ts` |
| Per-API trap coverage          | jsdom unit    | `test/trap/coverage.test.ts` |
| Harness HTML construction      | unit          | `test/runner/harness.test.ts` |
| CLI dispatcher                 | unit          | `test/cli/dispatch.test.ts` |
| `attach()` / `Session`         | playwright e2e | `test/runner/attach.e2e.test.ts` |
| Static + runtime merge         | unit on fixtures | `test/runner/merge.test.ts` |
| Real-world detector smoke      | playwright e2e | `test/e2e/detectors.test.ts` |

The trap-coverage test is the load-bearing one for catalog drift —
every entry in `ALL_APIS` must produce a fired event when the
property is read in a controlled fixture. New catalog entries that
forget to add the corresponding trap will fail the build.

---

## Catalog contract

The runtime layer makes two promises to anyone who maintains the
static catalog:

1. **Any new `ApiDefinition` entry produces a runtime trap on next
   build.** The generator reads `ALL_APIS` and emits the trap. If the
   key shape is unusual enough to need a hand-written rule, the
   generator emits a clear "no rule for key shape X" error rather
   than silently skipping.
2. **`watchedRoots()` is the source of truth for which globals get
   Proxy-wrapped.** A new root added there gets a Proxy wrapper in
   the trap script on next build.

Two contracts in the other direction:

3. **The runtime never invents new `ApiDefinition` keys.** If a key
   exists at runtime but not in the catalog, the runtime emits a
   `RawAccess` with no matched API; the static catalog gets a PR.
4. **The runtime never changes the matcher.** Runtime events are
   converted into `RawAccess` and fed to the same `matchAccesses` the
   static pass uses. If a chain doesn't match a catalog entry it's
   the catalog's problem.

---

## Maintainability principles

1. **Generated code is annotated.** The trap script is generated, but
   `buildTrapScript()` emits comments per section
   (`// ─── navigator root proxy ───`) so the produced script is
   readable when dumped from `--dump-trap`.
2. **Public symbols have JSDoc.** Even one-line types. Read your own
   types in six months.
3. **Failure modes are documented at the option.** Every flag in
   `RunnerOptions` has a doc comment that says what happens when it's
   omitted, what the default is, and what cost it implies.
4. **Hard caps are named constants.** `STACK_LIMIT`,
   `BUFFER_BYTE_CAP`, `EVAL_RECURSION_DEPTH`. No magic numbers in
   the trap script.
5. **The "what we cannot see" page is honest.** When we can't trap
   something, we say so. Limits page is part of the contract.
