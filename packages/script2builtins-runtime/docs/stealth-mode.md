---
title: Stealth mode
nav_order: 8
---

# Stealth mode

`script2builtins-runtime` ships a small **defensive shim** behind the
`--stealth` flag (or `attach({stealth: true})` in the library API).
The shim normalizes a handful of `navigator` / `Notification`
surfaces that headless Chromium gets wrong; it does **not** make the
trap itself stealthy, and it is **not** a scraping toolkit.

If you want to bypass a production bot detector at scale, you want a
different project. This document explains why, and is the matrix of
what the shim covers so you can pick what to layer on top.

## What `--stealth` actually patches

When enabled, the driver `addInitScript`s a tiny self-contained IIFE
**before** the trap. That order matters: the shim modifies
`Navigator.prototype` descriptors, then the trap's Proxy goes in on
top, so reads of these surfaces see the shim's values.

| Surface | Default | Why |
|---|---|---|
| `navigator.webdriver` | `false` (descriptor removed from instance, getter on `Navigator.prototype` returns `false`) | Single most reliable headless tell; set by Chrome under `--enable-automation`. |
| `navigator.languages` | `["en-US", "en"]` | Headless Chromium often ships with `[]` or a single-locale list — detectors compare against `navigator.language`. |
| `navigator.language` | `"en-US"` (first element of `languages`) | Has to agree with `languages`. |
| `navigator.plugins` | One synthesized PDF Viewer entry | Headless Chromium reports `plugins.length === 0`; a single-bit signal. |
| `navigator.platform` | unchanged unless overridden | Useful for normalizing across CI runners; set explicitly. |
| `Permissions.query({name:"notifications"})` | mirrors `Notification.permission` | Headless ships a known inconsistency (Permissions returns `"denied"`, Notification returns `"default"`). |

Every patch is optional — pass `attach({stealth: {hideWebdriver: false, …}})`
to skip individual surfaces.

## What `--stealth` does *not* do

This is the part worth reading.

1. **Trap-call latency.** Every cataloged surface that fires through
   the Proxy pays the cost of a getter trap, stack snapshot, and
   structured-clone push. `performance.now()` and `Date.now()` are
   not patched; a detector that compares wall-clock cost of a
   representative API against a hardware baseline sees the overhead.
   See [`limits.md`](./limits.html) §7.

2. **Trap-frame visibility.** `Error.prepareStackTrace` masking
   (Phase 1, D1) elides the trap's own frame from stack reads, but
   does not hide the trap's *source URL* from a detector that
   enumerates loaded scripts via `performance.getEntries()` or
   walks the DOM. The trap is injected via `addInitScript` which
   does not register a `script` element, so the DOM walk doesn't
   surface it — but the `performance` entries can.

3. **CDP fingerprints.** `navigator.userAgent` includes `HeadlessChrome`
   unless overridden via `--ua`. CDP-detection probes (e.g.
   evaluating a Function whose prototype was poisoned in a way that
   only CDP-attached Chromium exposes) are out of scope.

4. **TLS-layer fingerprints.** Anything observable below the JS API
   surface — JA3, JA4, HTTP/2 frame ordering, TLS extension ordering
   — is invisible to a page-script shim. Pair with
   [curl-impersonate], [tls-client], or [utls].

5. **Coherent fingerprint vector forgery.** The shim normalizes
   single surfaces; it does **not** construct an internally-consistent
   fingerprint vector (e.g. a `navigator.platform` of `"MacIntel"`
   plus a `WebGLDebugRendererInfo` reading `"Mesa Intel(R) UHD"` is
   incoherent and reads as a bot). The shim is a research tool that
   lets you continue analysis when the page would otherwise refuse to
   load; it is not a forgery tool.

[curl-impersonate]: https://github.com/lwthiker/curl-impersonate
[tls-client]: https://github.com/bogdanfinn/tls-client
[utls]: https://github.com/refraction-networking/utls

## Identifying the trap from outside

If you want to layer your own stealth scripts on top, the trap's
identifiers are **randomized per attach**. To avoid colliding with
them, read the names off the {@link Session} handle:

```ts
import { attach } from "script2builtins-runtime";

const session = await attach(context, { outDir: "./runs/x", stealth: true });
console.log(session.channelName);            // "__s2b_a1b2c3d4e5f6"
console.log(session.workerTrapGlobalName);   // "__s2bwt_0a1b2c3d4e5f"
console.log(session.trapScriptSha256);       // 64-char hex
console.log(session.stealthScriptSha256);    // 64-char hex (or null)
```

Your own init script can then walk `Object.keys(globalThis)` and skip
those two names — neither has a stable prefix, so a name-based
detector can't enumerate them without a dictionary.

## When to use it

`--stealth` is appropriate when:

- A target site refuses to render under headless Chromium and you
  need it to render long enough to capture detector source for
  static analysis.
- You want comparable runs across CI environments where one runner's
  default `navigator.languages` differs from another's.
- You are explicitly evaluating the cost-to-detection delta of a
  single shim.

It is **not** appropriate when:

- You want to scrape data at scale. Use a managed scraping service.
- You want to evade a production bot detector. Use a project whose
  threat model is evasion (this one's isn't).
- You want to fool a CreepJS-class checker. The Phase 1 anti-anti-debug
  work covers the call-site probes (toString shape, stack trace
  composition), but the long tail is open-ended; this is acknowledged
  as out of scope in [`limits.md`](./limits.html) §4.

## API

```ts
import { attach, run, buildStealthScript, type StealthOptions } from "script2builtins-runtime";

// Boolean: install with defaults.
await run({ url, outDir, stealth: true });

// Object: tune the matrix.
await run({
  url,
  outDir,
  stealth: {
    hideWebdriver: true,
    fakePlugins: true,
    languages: ["en-US", "en"],
    platform: "MacIntel",
    normalizePermissions: true,
  } satisfies StealthOptions,
});

// Or build the shim yourself for embedding into an existing
// `context.addInitScript` workflow:
const shim = buildStealthScript({ hideWebdriver: true });
// shim.source — the IIFE string
// shim.sha256 — identifier for cross-run comparison
```
