import type { Report, Finding, Severity, NetworkSink } from "../types.js";

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
  lines.push("");

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

function formatLoc(item: { loc: { start: { line: number; column: number } } | null }): string {
  if (!item.loc) return "?:?";
  return `${item.loc.start.line}:${item.loc.start.column}`;
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
