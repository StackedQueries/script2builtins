# Captured detector fixtures

Field-grade fixtures: real bot-detection scripts fetched from public,
unauthenticated endpoints and checked in here so the analyzer can be
tested end-to-end against shapes the synthetic fixtures
(`test/fixtures/synthetic/`) can't anticipate.

The companion E2E suite is `test/fixtures-captured.test.ts`. It is
gated behind `S2B_RUN_E2E=1` so default `npm test` stays fast:

```sh
S2B_RUN_E2E=1 npm test
```

## What's here

| File | Source | Vendor | Size | Notes |
|---|---|---|---:|---|
| `cloudflare-turnstile.js` | `https://challenges.cloudflare.com/turnstile/v0/api.js` | Cloudflare Turnstile | ~64 KB | Challenge-platform dispatcher. `api.js` redirects to `/v0/b/<build-hash>/api.js`; we save the resolved body. |
| `datadome.js` | `https://js.datadome.co/tags.js` | DataDome | ~110 KB | Behavioral-telemetry collector. Same script served to every customer; the per-tenant config (`window.dataDomeOptions`) is set on the embedding page, not inside this file. |
| `google-recaptcha.js` | `https://www.gstatic.com/recaptcha/releases/<hash>/recaptcha__en.js` (via `https://www.google.com/recaptcha/api.js`) | Google reCAPTCHA | ~860 KB | Full challenge script. The `api.js` loader is a tiny stub; the real meat lives at the versioned `gstatic.com` URL it embeds, which we follow once. |

These satisfy Phase 2 of `ROADMAP.md`: ≥3 real blobs, one Google, one
Cloudflare-class, one DataDome / Akamai / PerimeterX. Future
additions (Akamai sensor_data, PerimeterX init.js, Kasada ips.json)
should land here and grow `test/fixtures-captured.test.ts`.

## Refreshing

`scripts/fetch-fixtures.mjs` re-fetches every blob in one shot:

```sh
node scripts/fetch-fixtures.mjs           # rewrite the files in place
node scripts/fetch-fixtures.mjs --check   # report on-disk sizes without fetching
```

The script follows redirects, runs the `derived` step for reCAPTCHA
(extract the gstatic URL from the loader, then fetch it), and writes
the body to the corresponding `*.js` file. Expect vendor-driven
size/shape churn on every refresh — the assertions in
`fixtures-captured.test.ts` use lower-bound floors, not exact
matches, so they stay green across reasonable revisions.

## Collection recipe

For new vendors not currently in the table:

1. **Identify a publicly-served endpoint.** It must be:
   - Reachable without authentication, session cookies, or a
     customer-specific sitekey-routed URL.
   - The actual telemetry collector — not a loader that fetches the
     real script with a per-visitor parameter. If it's a loader, drop
     a `derived` step in `scripts/fetch-fixtures.mjs` (see the
     reCAPTCHA entry) to follow the indirection.

2. **Fetch with a real-browser UA, no Referer, no cookies.** Anything
   that looks session-bound (`?cb=<random>`, response sets a
   `Set-Cookie: dd_s=…`) means the vendor is binding the body to your
   visit — *do not check that in*. The point is to ship a static
   reference, not a one-shot per-fetch artifact.

3. **Diff two consecutive fetches.** If they're byte-identical (or
   differ only in obvious version strings / build hashes), the
   payload is stable enough to commit. If two refetches differ
   substantially, you're looking at per-visit randomization; treat
   the blob as a *runtime sample* and route it to the runtime repo's
   capture machinery instead.

4. **Search for embedded tokens.** Before committing:
   ```sh
   grep -oE '[a-f0-9]{32,}' new-blob.js | sort -u    # long hex tokens
   grep -oE '"sitekey"\s*:\s*"[^"]+"' new-blob.js     # baked-in sitekeys
   grep -E 'Set-Cookie|X-Token|Authorization' new-blob.js
   ```
   Any hit ⇒ either pick a different source (a generic dispatcher
   rather than a customer-routed delivery) or anonymize by replacing
   the value with a placeholder before commit. Record what was
   replaced in this README.

5. **Add a row to the table above** with the source URL, fetch date,
   vendor, and any anonymization notes.

6. **Add an entry to `sources` in `scripts/fetch-fixtures.mjs`** so
   the refresh path stays one command.

7. **Extend `test/fixtures-captured.test.ts`** with a `describe(...)`
   block. Use lower-bound floors (`expect(tells).toBeGreaterThan(N)`)
   rather than exact equality — vendor versions drift and absolute
   counts will too. Pin the specific high-signal claims (parse ok,
   specific categories present, specific structural finding present
   if one is detected today).

## Legal & ethical stance

These blobs are:

- **Publicly served.** Every URL in the table is reachable by any
  browser without authentication. There is no scraping of customer
  pages and no use of credentials.
- **Vendor-generic.** None of the bodies carries a customer-specific
  configuration, sitekey, or visitor token. They are the shared
  delivery scripts every customer of the vendor loads.
- **Used for defensive research.** The analyzer is a static-analysis
  tool for reverse-engineering what a detector probes so automation
  pipelines can be patched defensively and security engineers can
  audit detector behavior on traffic they own. See the repo
  `README.md` Disclaimer.

If you are a vendor and would prefer your blob not be used as a test
fixture, open an issue and we'll swap to a synthetic shape. The
synthetic fixtures in `test/fixtures/synthetic/` already cover the
canonical shapes; the captured fixtures here exist to catch shapes the
synthetic mocks miss, not to be the primary test surface.

## When to add a fixture vs. extend the synthetic set

| Goal | Use |
|---|---|
| Cover a specific catalog entry / detector pattern with a known-shape input | `test/fixtures/synthetic/` — hand-rolled, runs in default `npm test`, exact-match assertions |
| Catch shapes the synthetic mocks don't anticipate (real obfuscation, novel sink constructions, vendor-specific glue) | `test/fixtures/captured/` — real fetch, gated on `S2B_RUN_E2E=1`, floor-style assertions |

The captured set is *complementary*. It validates that real detector
JS in the wild still parses, still hits the expected categories, and
still produces useful summaries — not that any specific finding is
present at any specific count.
