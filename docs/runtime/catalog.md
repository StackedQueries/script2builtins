---
title: Catalog reference
nav_order: 6
---

# Catalog reference

`script2builtins-runtime` shares its catalog with `script2builtins` —
every entry in the `script2builtins-knowledge` package becomes a
runtime trap on the next build. This page explains the contract.

## The catalog source of truth

```ts
import { ALL_APIS, watchedRoots } from "script2builtins-knowledge";

console.log(ALL_APIS.length); // ~460 entries
console.log(watchedRoots().size); // ~150 roots
```

Each entry has the shape:

```ts
interface ApiDefinition {
  key: string;              // "navigator.userAgent" or "*.toDataURL"
  category: string;         // "navigator" | "canvas" | ...
  description: string;
  severity: "info" | "low" | "medium" | "high";
  botDetectionTell?: boolean;
  evasion?: string;
  argMatch?: string[];      // e.g. ["2d"] for getContext("2d")
}
```

## How runtime traps are generated from the catalog

For each entry, the trap script generator picks a strategy:

1. **Root + property** (e.g. `navigator.userAgent`). The root
   (`navigator`) is in `watchedRoots()`, so it's already Proxy-wrapped.
   The wrapper emits the access when `userAgent` is read off the
   Proxy. No extra code is generated.
2. **Wildcard suffix** (e.g. `*.toDataURL`). We can't know which
   prototype carries the method without checking. The generator emits
   a pinpoint patch on the known prototypes that own it
   (`HTMLCanvasElement.prototype.toDataURL`, etc.).
3. **`argMatch`** (e.g. `getContext` with `argMatch: ["2d"]`). The
   wrapper records the first string argument and the matcher routes
   the event to the catalog entry whose `argMatch` matches.

The runtime's role is to emit `RuntimeAccessEvent`s with chains that
match the catalog's lookup logic. **It does no matching itself** — the
driver's reconstruction step runs the same `matchAccesses` the static
pipeline uses, so the same catalog entry resolves the same way.

## Extending the catalog

Add an entry in `packages/script2builtins-knowledge/src/<category>.ts`.
On the next build of `script2builtins-runtime`, the trap script's generator
picks up the new entry and emits a trap for it. No edits to
`script2builtins-runtime` are required — the catalog is the
specification.

Two cases need a small extra step:

- **A new root identifier** that isn't currently in `watchedRoots()`.
  Add it there.
- **A new sink kind** (e.g. a future `RTCDataChannel.send` capture).
  Add the kind to `NetworkSinkKind` and add a wrapper in the trap
  script's sink table.

## Inspecting the trap script

If you want to see the exact runtime code that will be injected:

```ts
import { buildTrapScript } from "script2builtins-runtime/trap";

const { source, sha256, config } = buildTrapScript({
  useProxyRoots: true,
  trapDynamicExec: true,
  // Pass a stable channel name when running outside Playwright so
  // you can drain manually; otherwise leave it random per build.
  channelName: "__s2bRt",
});
process.stdout.write(source);
console.log("trap sha256:", sha256, "channel:", config.channelName);
```

The output is a single self-contained string with no imports, safe to
paste into Chrome DevTools' "Run snippet" or to drop into a browser
extension `content_scripts` entry. By default the channel is
installed under a per-build random name (`__s2b_<6 hex bytes>`); pass
`channelName` to override.

Two recent additions worth knowing:

- `trapReflectGet` (default `false`) — also wraps `Reflect.get`.
  Pulls in coverage of root references that bypassed the Proxy.
- `trapWorkers` (default `true`) — wraps classic `new Worker(url)`
  to bootstrap the trap inside worker scope. Module workers and
  `SharedWorker` pass through. The driver publishes
  `globalThis.__s2bWorkerTrap` as a sibling init script so the trap
  has the source to inject.
