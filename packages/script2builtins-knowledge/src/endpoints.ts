/**
 * Known anti-bot / anti-fraud infrastructure endpoints.
 *
 * Names are recognized by domain or path-substring matching against
 * statically-resolved sink URLs (`fetch`, `XHR`, `sendBeacon`,
 * `WebSocket`, `<img src>`, etc.) and against statically-traced
 * payload field names.
 *
 * Sourced from:
 *   - Kits Kärneriks §7 (PO Token endpoints).
 *   - SoK on client-side anti-automation §3.2 (vendor-mechanism matrix).
 *   - 2020 - Web Runner 2049: Evaluating Third-Party Anti-Bot Services.
 *   - 2020 - Inside The Black Box: A Glimpse Of Google's Internal Data
 *     Free-For-All.
 *   - public traces in `prescience-data/dark-knowledge` and CreepJS.
 *
 * The list is intentionally conservative — entries here should be
 * unambiguous (no legitimate-traffic false positives) so an analyst
 * can trust `sink.provider` as a confident classification rather than
 * a guess.
 */
export interface KnownEndpoint {
  /** Provider slug surfaced on `NetworkSink.provider`. */
  provider: string;
  /** Human-readable category for grouping (e.g. "anti-bot", "captcha", "fp-as-a-service"). */
  kind: "anti-bot" | "captcha" | "fp-as-a-service" | "ad-fraud" | "attestation";
  /** Substrings matched against the resolved URL (case-insensitive). */
  urlPatterns: string[];
  /**
   * Payload-field names that pin the provider when the URL itself
   * doesn't reveal it (e.g. when the script POSTs to a customer-
   * provided URL but the body still carries the vendor's field
   * conventions). Matched against `payload.entries[].key`.
   */
  payloadKeys?: string[];
  /** Short note for the report renderer. */
  note?: string;
}

export const knownEndpoints: KnownEndpoint[] = [
  // ── Google ─────────────────────────────────────────────────────────────────
  {
    provider: "Google reCAPTCHA",
    kind: "captcha",
    urlPatterns: [
      "www.google.com/recaptcha/",
      "www.gstatic.com/recaptcha/",
      "recaptcha.net/recaptcha/",
      "www.google.com/recaptcha/api2/",
      "www.google.com/recaptcha/enterprise/",
    ],
    payloadKeys: ["g-recaptcha-response", "g-recaptcha", "recaptcha-token"],
    note: "reCAPTCHA v2/v3 / Enterprise. v2 uses I'm-not-a-robot checkbox; v3 produces a score from background telemetry.",
  },
  {
    provider: "Google Botguard",
    kind: "attestation",
    urlPatterns: [
      "play.google.com/log",
      "accounts.google.com/_/IdentifierLookup",
      "accounts.google.com/_/lookup/accountlookup",
    ],
    payloadKeys: ["bgRequest", "bgresponse", "bg-resp"],
    note: "Google Botguard VM challenge/response. `bgRequest` is the attested token; presence in a request body is a near-certain Botguard signal.",
  },
  {
    provider: "Google PO Token (WAA)",
    kind: "attestation",
    urlPatterns: [
      "jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/Create",
      "jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT",
      "jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/",
    ],
    note: "YouTube PO-Token / Web Anti-Abuse (jnn-pa) endpoints. Used both for YouTube PO tokens and for Drive/Workspace attestation.",
  },

  // ── Cloudflare ─────────────────────────────────────────────────────────────
  {
    provider: "Cloudflare Turnstile",
    kind: "anti-bot",
    urlPatterns: [
      "challenges.cloudflare.com/turnstile/",
      "challenges.cloudflare.com/cdn-cgi/challenge-platform/",
    ],
    payloadKeys: ["cf-turnstile-response", "cdata"],
    note: "Cloudflare Turnstile managed challenge. The CDN-CGI challenge-platform endpoints are the JS-VM delivery vehicle.",
  },
  {
    provider: "Cloudflare Bot Management",
    kind: "anti-bot",
    urlPatterns: [
      "cdn-cgi/challenge-platform/",
      "cdn-cgi/bm/",
      "__cf_bm",
      "/cdn-cgi/rum",
    ],
    payloadKeys: ["__cf_chl_jschl_tk__", "__cf_chl_captcha_tk__", "__cf_bm"],
    note: "Cloudflare bot management challenge tokens and beacon paths.",
  },

  // ── DataDome ───────────────────────────────────────────────────────────────
  {
    provider: "DataDome",
    kind: "anti-bot",
    urlPatterns: [
      "js.datadome.co",
      "api-js.datadome.co",
      "geo.captcha-delivery.com",
      "captcha-delivery.com",
      ".datadome.co/captcha",
    ],
    payloadKeys: ["dd_cookie_test_", "__dd", "datadome", "dd_s"],
    note: "DataDome behavioral telemetry + captcha-delivery escalation path.",
  },

  // ── Akamai Bot Manager ────────────────────────────────────────────────────
  {
    provider: "Akamai Bot Manager",
    kind: "anti-bot",
    urlPatterns: [
      "/_bm/_data",
      "sensor_data",
      "/_bm/sd",
      "akam-sw.js",
    ],
    payloadKeys: ["sensor_data", "_abck"],
    note: "Akamai BMP. `sensor_data` is the canonical telemetry blob; `_abck` is the verification cookie.",
  },

  // ── PerimeterX / HUMAN ─────────────────────────────────────────────────────
  {
    provider: "PerimeterX / HUMAN",
    kind: "anti-bot",
    urlPatterns: [
      "perimeterx.net",
      "px-cdn.net",
      "px-cloud.net",
      "/px/api/",
      "/init.js",
    ],
    payloadKeys: ["_px3", "_pxhd", "_pxvid", "_pxff_cc"],
    note: "PerimeterX (HUMAN Security). `_px*` cookies are session/risk identifiers; init.js scripts vary per customer.",
  },

  // ── Imperva (Incapsula) ────────────────────────────────────────────────────
  {
    provider: "Imperva Incapsula",
    kind: "anti-bot",
    urlPatterns: [
      "imperva.com",
      "incapsula.com",
      "_Incapsula_Resource",
    ],
    payloadKeys: ["incap_ses_", "visid_incap_"],
    note: "Imperva / Incapsula bot management.",
  },

  // ── hCaptcha ───────────────────────────────────────────────────────────────
  {
    provider: "hCaptcha",
    kind: "captcha",
    urlPatterns: [
      "hcaptcha.com/",
      "js.hcaptcha.com",
      "newassets.hcaptcha.com",
      "hcaptcha.com/checkcaptcha/",
    ],
    payloadKeys: ["h-captcha-response", "hcaptcha-token"],
  },

  // ── Arkose Labs (FunCaptcha) ──────────────────────────────────────────────
  {
    provider: "Arkose Labs",
    kind: "captcha",
    urlPatterns: [
      "client-api.arkoselabs.com",
      "funcaptcha.com",
      "/fc/api/",
      "/fc/gc/",
    ],
    payloadKeys: ["fc-token", "ec_jws"],
    note: "Arkose Labs visual challenges (FunCaptcha). Often Type-II escalation when probabilistic signals are inconclusive.",
  },

  // ── FingerprintJS Pro ──────────────────────────────────────────────────────
  {
    provider: "FingerprintJS Pro",
    kind: "fp-as-a-service",
    urlPatterns: [
      "fpjs.io",
      "metrics.fingerprint.com",
      "/fp/result",
      "/fp/visitorId",
    ],
    payloadKeys: ["visitorId", "requestId"],
  },

  // ── Kasada ─────────────────────────────────────────────────────────────────
  {
    provider: "Kasada",
    kind: "anti-bot",
    urlPatterns: [
      "kasadacdn.com",
      "/ips.json",
      "/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/",
      "/fp",
      "tl=ck",
    ],
    note: "Kasada ships a WASM blob + obfuscated VM. The UUID path and `ips.json` are stable identifiers.",
  },

  // ── Shape Security (F5) ────────────────────────────────────────────────────
  {
    provider: "Shape Security (F5)",
    kind: "anti-bot",
    urlPatterns: [
      "shapecdn.io",
      "shapecdn.com",
      "/_bm/_sd",
    ],
  },

  // ── reblaze / GeeTest / Other captchas ─────────────────────────────────────
  {
    provider: "GeeTest",
    kind: "captcha",
    urlPatterns: [
      "geetest.com",
      "api.geetest.com",
      "static.geetest.com",
    ],
    payloadKeys: ["geetest_challenge", "geetest_validate", "geetest_seccode"],
  },
  {
    provider: "Reblaze",
    kind: "anti-bot",
    urlPatterns: [
      "rbzdns.com",
      "/_RBZIP/",
    ],
  },

  // ── Castle / Sift / similar risk APIs ──────────────────────────────────────
  {
    provider: "Castle",
    kind: "fp-as-a-service",
    urlPatterns: [
      "castle.io/v1/",
      "api.castle.io",
      "d2t77mnxyo7adj.cloudfront.net",
    ],
  },
  {
    provider: "Sift",
    kind: "fp-as-a-service",
    urlPatterns: [
      "cdn.siftscience.com",
      "api.siftscience.com",
      "/v3/accounts/",
    ],
  },
  {
    provider: "Forter",
    kind: "fp-as-a-service",
    urlPatterns: [
      "forter.com",
      "fcdn.forter-secure.com",
    ],
  },
];

/**
 * Classify a sink URL against the known-endpoint table.
 *
 * Case-insensitive substring match. Returns the first matching
 * provider — entries earlier in {@link knownEndpoints} take
 * precedence, so order specific patterns before generic ones.
 */
export function classifyEndpointUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const haystack = url.toLowerCase();
  for (const ep of knownEndpoints) {
    for (const pat of ep.urlPatterns) {
      if (haystack.includes(pat.toLowerCase())) return ep.provider;
    }
  }
  return null;
}

/**
 * Classify a sink by its statically-traced payload field names. Used
 * when the URL itself is opaque (template / dynamic / customer-routed)
 * but the body still carries vendor-specific keys.
 *
 * `keys` should be the list of `payload.entries[].key` strings from a
 * traced payload.
 */
export function classifyEndpointPayloadKeys(keys: string[]): string | null {
  if (!keys.length) return null;
  const lower = keys.map((k) => k.toLowerCase());
  for (const ep of knownEndpoints) {
    if (!ep.payloadKeys) continue;
    for (const k of ep.payloadKeys) {
      if (lower.includes(k.toLowerCase())) return ep.provider;
    }
  }
  return null;
}
