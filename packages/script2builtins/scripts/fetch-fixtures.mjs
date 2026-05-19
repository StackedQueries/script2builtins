#!/usr/bin/env node
/**
 * Fetch real captured detector blobs for the E2E test fixtures.
 *
 * Usage:
 *   node scripts/fetch-fixtures.mjs            # refresh all blobs
 *   node scripts/fetch-fixtures.mjs --check    # report on-disk vs upstream size only
 *
 * Each source is a publicly-served detector script — no auth, no
 * per-visitor token, fetched without a Referer or session cookie. The
 * resulting fixtures are checked in to `test/fixtures/captured/` so
 * `S2B_RUN_E2E=1 npm test` is deterministic; this script exists so
 * anyone can refresh them when a vendor rolls a new version.
 *
 * Anonymization recipe (when adding new sources): see
 * `test/fixtures/captured/README.md`. The current set is clean —
 * these blobs are static publicly-distributed JavaScript with no
 * embedded customer keys.
 */
import { writeFileSync, statSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "test", "fixtures", "captured");

const sources = [
  {
    name: "cloudflare-turnstile.js",
    url: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    note: "Cloudflare Turnstile challenge dispatcher. Loader redirects to a /turnstile/v0/b/<build-hash>/api.js path; we save the resolved body.",
  },
  {
    name: "datadome.js",
    url: "https://js.datadome.co/tags.js",
    note: "DataDome behavioral-telemetry collector. Same script served to every customer; customer-specific config (`window.dataDomeOptions`) is set on the host page, not in this file.",
  },
  {
    name: "google-recaptcha.js",
    url: "https://www.google.com/recaptcha/api.js",
    derived: async (loaderBody) => {
      const m = loaderBody.match(
        /https:\/\/www\.gstatic\.com\/recaptcha\/releases\/[^/]+\/recaptcha__en\.js/,
      );
      if (!m) throw new Error("Could not extract gstatic recaptcha URL from loader");
      return m[0];
    },
    note: "Google reCAPTCHA challenge script. The api.js loader is tiny and only embeds a versioned URL; we follow it to the full challenge JS (~850 KB).",
  },
];

const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchText(url) {
  const r = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": userAgent, accept: "*/*" },
  });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return { body: await r.text(), finalUrl: r.url };
}

async function refreshOne(src) {
  const first = await fetchText(src.url);
  let body = first.body;
  let finalUrl = first.finalUrl;
  if (src.derived) {
    const derivedUrl = await src.derived(body);
    const second = await fetchText(derivedUrl);
    body = second.body;
    finalUrl = second.finalUrl;
  }
  const target = resolve(fixturesDir, src.name);
  writeFileSync(target, body);
  return { target, bytes: body.length, finalUrl };
}

async function checkOne(src) {
  const target = resolve(fixturesDir, src.name);
  let onDisk = 0;
  try {
    onDisk = statSync(target).size;
  } catch {
    onDisk = -1;
  }
  return { name: src.name, onDisk };
}

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

if (checkOnly) {
  for (const src of sources) {
    const r = await checkOne(src);
    console.log(
      `${r.name.padEnd(30)} on-disk=${r.onDisk >= 0 ? r.onDisk.toString().padStart(7) + " B" : "MISSING"}`,
    );
  }
  process.exit(0);
}

for (const src of sources) {
  process.stdout.write(`${src.name.padEnd(30)} … `);
  try {
    const r = await refreshOne(src);
    console.log(`ok (${r.bytes} B)  ← ${r.finalUrl}`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}
