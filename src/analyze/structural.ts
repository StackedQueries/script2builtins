import type { Finding, StructuralFinding, RawAccess } from "../types.js";

/**
 * UA/feature consistency cross-check detector (IMPROVEMENTS.md B3).
 *
 * Detectors increasingly score the *inconsistency* between declared and
 * inferred environment signals, not absolute values (SoK §4.1
 * "containerization gap", `2017 - (Cross-)Browser Fingerprinting via OS
 * and Hardware Level Features`). The catalog already surfaces every
 * individual read; this post-pass emits a higher-signal finding when a
 * script reads BOTH halves of a known cross-check pair.
 *
 * Each pair encodes a hypothesis: "is this a real browser?" Reading
 * both members in the same script is a tell that the script is
 * scoring the answer, not just shipping the values.
 *
 * The pairs are intentionally conservative — every entry comes from a
 * specific paper or detector observation, not synthetic combinations.
 */

interface ConsistencyPair {
  subkind: string;
  description: string;
  /** Each member is an `api.key` string. ALL must be present for a hit. */
  members: string[];
}

const PAIRS: ConsistencyPair[] = [
  {
    subkind: "ua-vs-uach-platform",
    description:
      "Pairs `navigator.userAgent` with `navigator.userAgentData.platform` — UA-CH consistency cross-check. A spoofed UA usually leaves UA-CH untouched (or vice versa).",
    members: ["navigator.userAgent", "navigator.userAgentData.platform"],
  },
  {
    subkind: "platform-vs-uach-platform",
    description:
      "Pairs `navigator.platform` with `navigator.userAgentData.platform` — legacy-platform vs UA-CH-platform consistency.",
    members: ["navigator.platform", "navigator.userAgentData.platform"],
  },
  {
    subkind: "timezone-cross-check",
    description:
      "Pairs `Intl.DateTimeFormat().resolvedOptions().timeZone` with `Date.prototype.getTimezoneOffset` (or `Date.toString`) — timezone-spoofing consistency check; a known headless tell.",
    members: ["Intl.DateTimeFormat", "*.getTimezoneOffset"],
  },
  {
    subkind: "touch-consistency",
    description:
      "Pairs `navigator.maxTouchPoints` with `TouchEvent` presence — mobile-UA spoofing tell when these disagree.",
    members: ["navigator.maxTouchPoints", "TouchEvent"],
  },
  {
    subkind: "gpu-os-consistency",
    description:
      "Pairs WebGL `UNMASKED_RENDERER_WEBGL` access with `navigator.platform` — GPU/OS cross-check (a Mac claiming an NVIDIA renderer is a strong tell).",
    members: ["*.getExtension", "navigator.platform"],
  },
  {
    subkind: "geometry-triangulation",
    description:
      "Pairs screen dimensions with `devicePixelRatio` and `outerWidth` — geometry triangulation for window-size spoofing detection.",
    members: ["screen.width", "screen.height", "devicePixelRatio"],
  },
  {
    subkind: "language-cross-check",
    description:
      "Pairs `navigator.language` with `navigator.languages` — single-language vs multi-language consistency.",
    members: ["navigator.language", "navigator.languages"],
  },
];

/**
 * High-res-timer-construction detector (IMPROVEMENTS.md A5).
 *
 * Mitigations against `performance.now` precision (Spectre-era browser
 * patches that round it to ms) pushed detectors and side-channel
 * attackers alike to *reconstruct* a sub-µs timer out of
 * `SharedArrayBuffer` + atomic operations. The canonical construction
 * (Fantastic Timers and Where to Find Them, 2017; JavaScript Zero,
 * 2018) spawns a Worker that increments a `SharedArrayBuffer`-backed
 * counter in a tight `Atomics.add` loop, then reads the counter via
 * `Atomics.load` to get a high-res tick.
 *
 * The static signature: BOTH `SharedArrayBuffer` and at least one of
 * `Atomics.wait` / `Atomics.load` / `Atomics.store` / `Atomics.add`
 * appear in the same script. Individually these are catalog entries;
 * together they're a single legible "this script is building a
 * sub-µs timer" verdict.
 */
const TIMER_ATOMIC_KEYS = new Set([
  "Atomics.wait",
  "Atomics.notify",
  "Atomics.load",
  "Atomics.store",
  "Atomics.add",
]);

export function detectHighResTimer(findings: Finding[]): StructuralFinding[] {
  let sab: RawAccess | undefined;
  const atomicHits: { key: string; hit: RawAccess }[] = [];
  for (const f of findings) {
    if (f.api.key === "SharedArrayBuffer" && f.hits[0]) sab = f.hits[0];
    if (TIMER_ATOMIC_KEYS.has(f.api.key) && f.hits[0]) {
      atomicHits.push({ key: f.api.key, hit: f.hits[0] });
    }
  }
  if (!sab || atomicHits.length === 0) return [];
  const witness = sab;
  return [
    {
      kind: "high-res-timer-construction",
      subkind: "sab-plus-atomics",
      severity: "high",
      description:
        "SharedArrayBuffer co-occurs with Atomics.wait/load/store/add — sub-µs timer reconstruction (Fantastic Timers 2017 / JavaScript Zero 2018). Replaces mitigated `performance.now` for cache-probing or anti-debug timing.",
      details: {
        members: ["SharedArrayBuffer", ...atomicHits.map((a) => a.key)],
        witnesses: [
          { key: "SharedArrayBuffer", loc: sab.loc, snippet: sab.snippet },
          ...atomicHits.map((a) => ({ key: a.key, loc: a.hit.loc, snippet: a.hit.snippet })),
        ],
      },
      loc: witness.loc,
      snippet: witness.snippet,
    },
  ];
}

/**
 * Run the consistency cross-check post-pass against a set of findings.
 * Emits one StructuralFinding per fully-matched pair. The `loc` /
 * `snippet` come from the first hit of the highest-listed member.
 */
export function detectConsistencyChecks(findings: Finding[]): StructuralFinding[] {
  const byKey = new Map<string, RawAccess[]>();
  for (const f of findings) byKey.set(f.api.key, f.hits);

  const out: StructuralFinding[] = [];
  for (const pair of PAIRS) {
    const matchedMembers: { key: string; hit: RawAccess }[] = [];
    let complete = true;
    for (const m of pair.members) {
      const hits = byKey.get(m);
      if (!hits || hits.length === 0) {
        complete = false;
        break;
      }
      matchedMembers.push({ key: m, hit: hits[0]! });
    }
    if (!complete) continue;
    const witness = matchedMembers[0]!.hit;
    out.push({
      kind: "consistency-check",
      subkind: pair.subkind,
      severity: "high",
      description: pair.description,
      details: {
        members: pair.members,
        witnesses: matchedMembers.map((m) => ({
          key: m.key,
          loc: m.hit.loc,
          snippet: m.hit.snippet,
        })),
      },
      loc: witness.loc,
      snippet: witness.snippet,
    });
  }
  return out;
}
