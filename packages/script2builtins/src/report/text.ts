import type { Report, Finding, Severity, NetworkSink, StructuralFinding, SokLayer } from "../types.js";

export interface RenderTextOptions {
  /** Show evidence (snippets + line numbers) per finding. Default true. */
  showHits?: boolean;
  /** Cap evidence rows per finding. Default 5. */
  maxHitsPerFinding?: number;
  /** Filter to severities ≥ this rank. Default "info" (no filter). */
  minSeverity?: Severity;
  /** Restrict to these categories (lowercased). Default: all. */
  categories?: string[];
  /** Strip ANSI colour codes. Default false. */
  noColor?: boolean;
  /** Hide the network-sinks section. Default false. */
  hideSinks?: boolean;
  /** Show *only* the network-sinks section + summary. Default false. */
  sinksOnly?: boolean;
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

function paint(s: string, color: keyof typeof C, noColor: boolean): string {
  if (noColor) return s;
  return `${C[color]}${s}${C.reset}`;
}

function severityBadge(sev: Severity, noColor: boolean): string {
  const tag = sev.toUpperCase().padEnd(6);
  switch (sev) {
    case "high": return paint(tag, "red", noColor);
    case "medium": return paint(tag, "yellow", noColor);
    case "low": return paint(tag, "cyan", noColor);
    case "info": return paint(tag, "gray", noColor);
  }
}

export function renderText(report: Report, options: RenderTextOptions = {}): string {
  const showHits = options.showHits ?? true;
  const maxHits = options.maxHitsPerFinding ?? 5;
  const minSev = options.minSeverity ?? "info";
  const noColor = options.noColor ?? false;
  const catFilter = options.categories ? new Set(options.categories.map((c) => c.toLowerCase())) : null;

  const lines: string[] = [];

  // Header
  lines.push(paint("script2builtins forensic report", "bold", noColor));
  lines.push(
    `${paint("source", "dim", noColor)}    ${report.source.name}  ` +
    `${paint("bytes", "dim", noColor)} ${report.source.bytes}  ` +
    `${paint("lines", "dim", noColor)} ${report.source.lines}  ` +
    `${paint("parse", "dim", noColor)} ${report.parse.ok ? `ok (${report.parse.sourceType})` : "FAILED"}`,
  );
  if (!report.parse.ok) {
    for (const e of report.parse.errors) lines.push(`  ${paint("!", "red", noColor)} ${e}`);
  }
  // 30-second triage line: a single-sentence classification of what
  // this script looks like, derived from the summary fields. Lands at
  // the very top so analysts opening a fresh report don't need to read
  // past the header to know what they're dealing with.
  const verdict = classifyScript(report);
  if (verdict) {
    lines.push(`${paint("verdict", "dim", noColor)}   ${paint(verdict, "magenta", noColor)}`);
  }
  lines.push("");

  // Summary
  const s = report.summary;
  lines.push(paint("summary", "bold", noColor));
  lines.push(`  total accesses          ${s.totalAccesses}`);
  lines.push(`  known fingerprint API   ${s.knownAccesses}`);
  lines.push(`  bot-detection tells     ${paint(String(s.botDetectionTells), s.botDetectionTells > 0 ? "red" : "gray", noColor)}`);
  lines.push(`  density (hits / KB)     ${s.fingerprintingDensityPerKb}`);
  lines.push(`  categories touched      ${s.categories.join(", ") || "(none)"}`);
  lines.push(`  network sinks           ${paint(String(s.sinkCount), s.sinkCount > 0 ? "magenta" : "gray", noColor)}`);
  lines.push(`  fingerprints exfiltrated ${paint(String(s.leakedApiCount), s.leakedApiCount > 0 ? "red" : "gray", noColor)}`);
  lines.push(`  anti-debug tells        ${paint(String(s.antiDebugTells), s.antiDebugTells > 0 ? "red" : "gray", noColor)}`);
  lines.push(`  consistency checks      ${paint(String(s.consistencyChecks), s.consistencyChecks > 0 ? "yellow" : "gray", noColor)}`);
  lines.push(`  VM bytecode detected    ${paint(s.vmBytecodeDetected ? "yes" : "no", s.vmBytecodeDetected ? "red" : "gray", noColor)}`);
  lines.push("");

  // SoK L1–L4 bucketed summary (Abel 2024). Lets readers of the
  // anti-automation literature map findings to the framework directly.
  const buckets = bucketByLayer(report.findings);
  const hasAny = (["L1a", "L1b", "L2", "L3", "L4"] as SokLayer[]).some((l) => (buckets[l] ?? 0) > 0);
  if (hasAny) {
    lines.push(paint("layers (SoK)", "bold", noColor));
    const ORDER: { layer: SokLayer; label: string }[] = [
      { layer: "L1a", label: "L1a static introspection" },
      { layer: "L1b", label: "L1b behavioral biometrics" },
      { layer: "L2", label: "L2  source obfuscation" },
      { layer: "L3", label: "L3  execution traps" },
      { layer: "L4", label: "L4  chronometric integrity" },
    ];
    for (const { layer, label } of ORDER) {
      const n = buckets[layer] ?? 0;
      const color = n > 0 ? "yellow" : "gray";
      lines.push(`  ${label.padEnd(28)} ${paint(String(n), color, noColor)}`);
    }
    lines.push("");
  }

  // Network sinks
  if (!options.hideSinks && report.networkSinks.length > 0) {
    lines.push(paint(`network sinks (${report.networkSinks.length})`, "bold", noColor));
    for (const sink of report.networkSinks) {
      renderSink(sink, lines, noColor);
    }
    lines.push("");
  }

  if (options.sinksOnly) {
    return lines.join("\n");
  }

  // Structural findings (VM-bytecode + consistency cross-checks)
  if (report.structural.length > 0) {
    lines.push(paint(`structural findings (${report.structural.length})`, "bold", noColor));
    for (const sf of report.structural) {
      renderStructural(sf, lines, noColor);
    }
    lines.push("");
  }

  // Hazards
  if (report.hazards.length > 0) {
    lines.push(paint(`dynamic hazards (${report.hazards.length})`, "bold", noColor));
    for (const h of report.hazards.slice(0, 25)) {
      lines.push(`  ${paint(h.kind.padEnd(20), "magenta", noColor)} ${formatLoc(h)}  ${h.snippet}`);
      lines.push(`    ${paint(h.detail, "dim", noColor)}`);
    }
    if (report.hazards.length > 25) {
      lines.push(`  ${paint(`… ${report.hazards.length - 25} more hazards`, "dim", noColor)}`);
    }
    lines.push("");
  }

  // Findings, grouped by category
  const filtered = report.findings.filter((f) => {
    if (SEV_RANK[f.api.severity] > SEV_RANK[minSev]) return false;
    if (catFilter && !catFilter.has(f.api.category.toLowerCase())) return false;
    return true;
  });

  if (filtered.length === 0) {
    lines.push(paint("no fingerprinting APIs detected at the requested filter level.", "dim", noColor));
    return lines.join("\n");
  }

  const byCat: Record<string, Finding[]> = {};
  for (const f of filtered) (byCat[f.api.category] ??= []).push(f);
  const cats = Object.keys(byCat).sort();

  lines.push(paint(`findings (${filtered.length})`, "bold", noColor));
  for (const cat of cats) {
    const findings = byCat[cat];
    if (!findings) continue;
    const catTells = findings.reduce((n, f) => n + (f.api.botDetectionTell ? f.count : 0), 0);
    const catTotal = findings.reduce((n, f) => n + f.count, 0);
    const tellSuffix = catTells > 0
      ? `  ${paint(`(${catTells} bot-detection tell${catTells === 1 ? "" : "s"})`, "red", noColor)}`
      : "";
    lines.push("");
    lines.push(`${paint("[" + cat + "]", "cyan", noColor)}  ${paint(String(catTotal) + " hits", "dim", noColor)}${tellSuffix}`);
    for (const f of findings) {
      const tell = f.api.botDetectionTell ? paint(" TELL", "red", noColor) : "";
      lines.push(
        `  ${severityBadge(f.api.severity, noColor)} ${paint(f.api.key, "bold", noColor)}` +
        ` ${paint("×" + f.count, "dim", noColor)}${tell}`,
      );
      lines.push(`    ${paint(f.api.description, "dim", noColor)}`);
      if (f.api.evasion) {
        lines.push(`    ${paint("evasion:", "green", noColor)} ${f.api.evasion}`);
      }
      if (showHits) {
        const evidence = f.hits.slice(0, maxHits);
        for (const h of evidence) {
          lines.push(`      ${paint("·", "gray", noColor)} ${formatLoc(h)}  ${h.snippet}`);
        }
        if (f.hits.length > maxHits) {
          lines.push(`      ${paint(`… ${f.hits.length - maxHits} more`, "dim", noColor)}`);
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Inspect the report summary and return a one-line "what this script
 * appears to be" classification. Returns null when nothing meaningful
 * is detectable (e.g., an empty or trivial script).
 *
 * Precedence is intentional: a positively-identified provider beats a
 * VM-bytecode finding (a Botguard VM that also matched a Cloudflare
 * URL is *both*, but the provider is the more informative anchor),
 * which beats a generic "VM/anti-debug" verdict, which beats
 * fingerprinter/canvas-class buckets.
 */
function classifyScript(report: Report): string | null {
  const s = report.summary;
  const provider = topProvider(s.providers);
  const hasVm = s.vmBytecodeDetected;
  const antiDebug = s.antiDebugTells;
  const consistency = s.consistencyChecks;

  if (provider) {
    if (hasVm) return `${provider} blob (VM-class anti-bot — bytecode + dispatch detected).`;
    if (antiDebug > 0) return `${provider} telemetry (${antiDebug} anti-debug tells${consistency ? `, ${consistency} consistency check${consistency === 1 ? "" : "s"}` : ""}).`;
    return `${provider} telemetry / fingerprinter.`;
  }
  if (hasVm) {
    return `Bytecode-VM detector (Botguard / Kasada / Hyperion class). ${s.botDetectionTells} bot tells; ${antiDebug} anti-debug tells.`;
  }
  if (antiDebug >= 3 && consistency >= 1) {
    return `Active anti-debug fingerprinter (${antiDebug} L3/L4 tells, ${consistency} consistency check${consistency === 1 ? "" : "s"}).`;
  }
  if (antiDebug >= 3) {
    return `Active anti-debug script (${antiDebug} L3/L4 tells).`;
  }
  // Category-based guesses fall back to a softer verdict.
  const cats = new Set(s.categories);
  if (cats.has("canvas") && s.botDetectionTells > 5) return "Canvas-class fingerprinter.";
  if (cats.has("webgl") && s.botDetectionTells > 5) return "WebGL / GPU fingerprinter.";
  if (cats.has("audio") && s.botDetectionTells > 5) return "AudioContext fingerprinter.";
  if (s.botDetectionTells >= 10 && s.leakedApiCount >= 3) return "Generic fingerprinting beacon.";
  return null;
}

function topProvider(providers: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, n] of Object.entries(providers)) {
    if (n > bestCount) {
      bestCount = n;
      best = k;
    }
  }
  return best;
}

function bucketByLayer(findings: Finding[]): Partial<Record<SokLayer, number>> {
  const out: Partial<Record<SokLayer, number>> = {};
  for (const f of findings) {
    const layer = f.api.layer;
    if (!layer) continue;
    out[layer] = (out[layer] ?? 0) + f.count;
  }
  return out;
}

function formatLoc(item: { loc: { start: { line: number; column: number } } | null }): string {
  if (!item.loc) return "?:?";
  return `${item.loc.start.line}:${item.loc.start.column}`;
}

function renderStructural(sf: StructuralFinding, lines: string[], noColor: boolean): void {
  const label = `${sf.kind}/${sf.subkind}`.padEnd(28);
  lines.push(`  ${severityBadge(sf.severity, noColor)} ${paint(label, "bold", noColor)} ${formatLoc(sf)}`);
  lines.push(`    ${paint(sf.description, "dim", noColor)}`);
  if (sf.kind === "vm-bytecode") {
    const d = sf.details as {
      bytecodeEntries?: number;
      bytecodeBytes?: number;
      dispatchSwitchArms?: number;
      indexedFunctionCallArms?: number;
      fromCharCodeApplyCount?: number;
    };
    const parts = [
      d.bytecodeEntries !== undefined ? `bytecode ${d.bytecodeEntries} entries` : "",
      d.bytecodeBytes ? `${d.bytecodeBytes}B` : "",
      d.dispatchSwitchArms ? `switch ${d.dispatchSwitchArms} arms` : "",
      d.indexedFunctionCallArms ? `${d.indexedFunctionCallArms} indexed-call arms` : "",
      d.fromCharCodeApplyCount ? `${d.fromCharCodeApplyCount}× String.fromCharCode.apply` : "",
    ].filter(Boolean);
    if (parts.length) lines.push(`    ${paint(parts.join("  ·  "), "yellow", noColor)}`);
  } else if (sf.kind === "consistency-check") {
    const d = sf.details as { members?: string[] };
    if (d.members && d.members.length) {
      lines.push(`    ${paint("members: " + d.members.join(", "), "yellow", noColor)}`);
    }
  } else if (sf.kind === "cognitive-honeypot") {
    const d = sf.details as {
      varName?: string;
      tagName?: string | null;
      evidence?: Record<string, boolean>;
    };
    const ev = d.evidence ?? {};
    const flags = Object.entries(ev).filter(([, v]) => v).map(([k]) => k).join(", ");
    const parts = [
      d.varName ? `var ${d.varName}` : "",
      d.tagName ? `tag ${d.tagName}` : "",
      flags || "",
    ].filter(Boolean);
    if (parts.length) lines.push(`    ${paint(parts.join("  ·  "), "yellow", noColor)}`);
  } else if (sf.kind === "high-res-timer-construction") {
    const d = sf.details as { members?: string[] };
    if (d.members && d.members.length) {
      lines.push(`    ${paint("members: " + d.members.join(", "), "yellow", noColor)}`);
    }
  } else if (sf.kind === "favicon-cache-probe") {
    const d = sf.details as { varName?: string | null };
    if (d.varName) {
      lines.push(`    ${paint("var " + d.varName, "yellow", noColor)}`);
    }
  }
}

function renderSink(sink: NetworkSink, lines: string[], noColor: boolean): void {
  const kindLabel = paint(sink.kind.padEnd(16), "magenta", noColor);
  const method = sink.method ? `${sink.method} ` : "";
  const urlDisplay = sink.url ? sink.url : sink.urlSnippet ? `«dynamic: ${sink.urlSnippet}»` : "«unknown URL»";
  lines.push(`  ${kindLabel} ${formatLoc(sink)}  ${method}${paint(urlDisplay, "cyan", noColor)}`);

  const headerKeys = Object.keys(sink.headers);
  if (headerKeys.length > 0) {
    const flat = headerKeys.map((k) => `${k}: ${sink.headers[k] ?? "«dynamic»"}`).join("  ");
    lines.push(`    ${paint("headers:", "dim", noColor)} ${flat}`);
  }

  if (sink.payload) {
    const p = sink.payload;
    const leakedNote = p.leakedApis.length > 0
      ? paint(` (${p.leakedApis.length} fingerprint API${p.leakedApis.length === 1 ? "" : "s"} exfiltrated)`, "red", noColor)
      : "";
    lines.push(`    ${paint("payload:", "dim", noColor)} ${p.shape}${leakedNote}`);
    if (p.entries.length === 0) {
      lines.push(`      ${paint("(opaque body)", "dim", noColor)}`);
    } else {
      for (const e of p.entries.slice(0, 20)) {
        const valDisplay = e.leakedApi
          ? `${paint(e.leakedApi.key, "red", noColor)} ${paint("[" + e.leakedApi.category + "]", "dim", noColor)}`
          : e.sourceChain
            ? paint(e.sourceChain.map((s) => s ?? "?").join("."), "yellow", noColor)
            : e.literalValue !== undefined
              ? paint(JSON.stringify(e.literalValue), "green", noColor)
              : paint(e.snippet, "dim", noColor);
        lines.push(`      ${paint("·", "gray", noColor)} ${e.key.padEnd(20)} = ${valDisplay}`);
      }
      if (p.entries.length > 20) {
        lines.push(`      ${paint(`… ${p.entries.length - 20} more entries`, "dim", noColor)}`);
      }
    }
  }
}
