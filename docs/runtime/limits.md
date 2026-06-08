---
title: Limits
nav_order: 7
---

# Limits

Even with full runtime instrumentation, there is a small residual set
of cases the pipeline can't fully resolve. This page is the honest
inventory.

## 1. Surfaces below the JS API boundary

Some fingerprint signals are not visible through any JS-observable
function call. Examples:

- **Per-GPU shader timing residue** (DRAWNAPART-style) shows up as a
  WebGL timer-query *result value*. We see the API calls; we don't
  reproduce the value derivation. To reproduce the value you'd need to
  run the same code on the same GPU.
- **CPU pipeline stalls** measured via SAB / `Atomics.wait` budgets
  (Snitch-style). Same caveat — we see the API calls and capture the
  measured numbers, but those numbers are hardware-derived.
- **Anti-aliasing rasterizer output.** Canvas hashes reflect the
  rasterizer; we see the input drawing calls and the
  `toDataURL` output, but the hash is what it is.

Bottom line: we make the *probes* legible, not the underlying
hardware. That's the right granularity for stealth-automation
research; if you want to spoof the *values*, that's a separate set of
tools.

## 2. Code that we cannot inject before

`addInitScript` runs before page scripts in the main world. It does
**not** run before a script in a sandboxed iframe whose
`Content-Security-Policy` forbids it, or in a cross-origin frame
whose contents we cannot drive. For those frames the runtime falls
back to the static pass on the captured network payloads — the same
level of coverage as `script2builtins` alone.

Same-origin iframes (including `srcdoc=…` ones) inherit the parent
origin and therefore the init script. We additionally walk
`iframe[srcdoc]` attributes and pull inline `<script>` bodies through
the static analyzer so the source is captured even when the iframe
was removed pre-execution. Captured srcdoc scripts surface as
`acquisition: "srcdoc"` in the per-script bundle (and as
`summary.srcdocScripts`).

## 2b. Worker scope coverage

Classic `new Worker(url)` is instrumented by default
(`trapWorkers: true`): the trap rewrites the constructor to bootstrap
the trap via `importScripts(<trap blob>)` before the user URL. The
trap source is published by the driver as `globalThis.__s2bWorkerTrap`
via a sibling init script.

Two shapes are NOT instrumented inside their scope (the sink event
`worker` / `shared-worker` still fires, so the URL is in the report):

- **Module workers** (`{ type: "module" }`) — they use ES-module
  `import`, not `importScripts`; no equivalent synchronous bootstrap.
- **`SharedWorker`** — `importScripts(<blob>)` support in
  shared-worker scopes is browser-version-sensitive; we'd risk
  breaking the worker.

`ServiceWorker.register(…)` shows up as a sink (`service-worker`),
but the registered worker runs in its own lifecycle outside the page
context, so traps do not reach it.

## 3. Subresource Integrity-protected scripts

A script tag with a hard `integrity` attribute cannot be MITM-rewritten
to add our traps inline. We still trap *all calls into the platform*
via the global / prototype patches, so the inside of the protected
script is observed normally. The only blind spot here is if the script
deliberately stashes pristine references before any wrapper runs — and
that's a race against `addInitScript`, which we win.

## 4. Code that detects us through invariant breaks

A motivated detector can find one of:

- `Object.getPrototypeOf(navigator) !== Navigator.prototype` (we
  Proxy `navigator`).
- `Function.prototype.toString` returning bytes whose length doesn't
  match the historical native-fn length for that method.
- `Error.prototype.stack` containing a frame from our wrapper's
  source URL.

Mitigations (Phase 5) cover the common idioms but the long tail is
an infinite cat-and-mouse. We report the detection (`introspection`
category, `Function.prototype.toString` `botDetectionTell`) rather
than try to mask every variant.

## 5. Loaded-but-never-executed code

Static reports list every cataloged surface in the source. Runtime
lists only the surfaces that ran. If your goal is "what *could* this
detector probe under different conditions", the static pass is the
authority; runtime is the authority for "what did it probe this
load".

The `staticOnlyKeys` array in the runtime summary surfaces the diff —
that's by design.

## 6. Side-channel exfiltration

We watch JS-visible sinks. A page can in principle exfiltrate via:

- Pixel patterns in a rendered canvas read by a sibling tab via
  `BroadcastChannel`.
- DNS prefetch / preload link timings.
- WebRTC ICE candidate gathering as a side channel.

The first two we don't catch. The third we catch as
`RTCPeerConnection` API use, but the ICE-candidate enumeration is the
fingerprint, not the API call itself. We surface the *capability* —
the rest is your problem.

## 7. Macroscopic latency from trap dispatch

The trap adds a measurable amount of per-call overhead: a Proxy `get`
trap, a stack-frame snapshot, and a structured-clone-safe push into
the in-page event buffer. On hot paths (a getter inside a tight
animation loop, say) this is observable from the page. We **do not**
attempt to neutralize that latency — `performance.now()` and friends
return their real wall-clock values, and `Date.now()` is unpatched.

This is deliberate, not a bug. A motivated detector can compare the
wall-clock cost of a representative API call against a hardware-derived
baseline and infer that something is reading the call. The mitigation
is to run the trap with a tighter `trapCategories` list (skip the hot
ones you don't need), to set `--no-trap-reflect-get` on hot pages, or
to accept that the run is research-grade rather than production
stealth. The toolkit is not a scraping framework — see
[`stealth-mode`](./stealth-mode.html) for the matrix of what each
defensive shim does and does not buy.

Operator-Synthesis-era ([SoK 2024]) and VLM-based detectors that
classify a session by reasoning over the trace of API call timings
will see this overhead. Hiding from them is out of scope.

[SoK 2024]: https://www.usenix.org/conference/usenixsecurity24/presentation/azad
