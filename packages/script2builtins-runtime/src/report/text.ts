/**
 * Render a {@link RuntimeReport} as a human-readable text report.
 *
 * Extends the static `renderText` with:
 *   - a provenance column on every finding
 *   - the runtimeOnly / staticOnly gap summary
 *   - per-script trap-coverage breakdown
 */
import type { RuntimeReport, AnnotatedFinding } from "../types.js";

export interface RenderRuntimeOptions {
  minSeverity?: "info" | "low" | "medium" | "high";
  showStacks?: boolean;
  showStaticOnly?: boolean;
  showRuntimeOnly?: boolean;
  maxHitsPerFinding?: number;
  noColor?: boolean;
}

const SEV_ORDER: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3 };

export function renderRuntimeText(report: RuntimeReport, opts: RenderRuntimeOptions = {}): string {
  const minSev = SEV_ORDER[opts.minSeverity ?? "info"]!;
  const maxHits = opts.maxHitsPerFinding ?? 5;
  const color = !opts.noColor;
  const c = makeColor(color);

  const out: string[] = [];

  // ─── header ──────────────────────────────────────────────────────
  out.push(c.bold("script2builtins-runtime — forensic report"));
  out.push(`target           ${report.target}`);
  out.push(`runId            ${report.runId}`);
  out.push(`harness mode     ${report.harnessMode}`);
  out.push(`report version   ${report.reportVersion}`);
  out.push(`catalog          ${report.catalogVersion}`);
  out.push(`trap script sha  ${report.trapScriptSha256.slice(0, 16)}…`);
  if (report.navError) out.push(c.red(`nav error        ${report.navError}`));
  out.push("");

  // ─── summary ─────────────────────────────────────────────────────
  out.push(c.bold("summary"));
  const s = report.summary;
  out.push(
    `  scripts captured        ${s.totalScripts} ` +
      `(network ${s.networkScripts}, inline ${s.inlineScripts}, ` +
      `srcdoc ${s.srcdocScripts}, eval ${s.evalScripts})`,
  );
  out.push(`  total accesses          ${s.totalAccesses} (runtime ${s.runtimeAccesses}, static ${s.staticAccesses})`);
  out.push(`  known fingerprint APIs  ${s.knownAccesses}`);
  out.push(`  bot-detection tells     ${s.botDetectionTells}`);
  out.push(`  network sinks           ${s.sinkCount}`);
  out.push(`  fingerprints exfiltrated ${s.leakedApiCount}`);
  out.push(`  categories (runtime)    ${s.runtimeCategories.join(", ") || "-"}`);
  if (s.preExistingPages > 0) out.push(c.yellow(`  ⚠ pre-existing pages    ${s.preExistingPages} (not instrumented)`));
  if (s.bufferOverflows > 0) {
    const bk = s.bufferOverflowsByKind;
    out.push(
      c.yellow(
        `  ⚠ buffer overflows      ${s.bufferOverflows}  (access ${bk.access}, sink ${bk.sink}, hazard ${bk.hazard})`,
      ),
    );
    if (bk.sink > 0 || bk.hazard > 0) {
      out.push(c.red(`     high-signal events were dropped — raise bufferByteCap`));
    }
  }
  out.push("");

  // ─── gap analysis ────────────────────────────────────────────────
  if (s.runtimeOnlyKeys.length > 0) {
    out.push(c.bold(c.yellow("runtime-only keys (eval / dynamic / Reflect surfaces)")));
    for (const k of s.runtimeOnlyKeys.slice(0, 30)) out.push(`  ${k}`);
    if (s.runtimeOnlyKeys.length > 30) out.push(`  … and ${s.runtimeOnlyKeys.length - 30} more`);
    out.push("");
  }
  if (s.staticOnlyKeys.length > 0 && opts.showStaticOnly !== false) {
    out.push(c.bold(c.dim("static-only keys (dead code / untaken branches)")));
    for (const k of s.staticOnlyKeys.slice(0, 30)) out.push(`  ${k}`);
    if (s.staticOnlyKeys.length > 30) out.push(`  … and ${s.staticOnlyKeys.length - 30} more`);
    out.push("");
  }

  // ─── per-script bundle ───────────────────────────────────────────
  out.push(c.bold("per-script trap coverage"));
  for (const sc of report.scripts) {
    const cov = `${(sc.trapCoverage * 100).toFixed(0)}%`;
    const flag = sc.staticReport.summary.botDetectionTells > 0 ? c.yellow("★") : " ";
    out.push(`  ${flag} ${truncate(sc.name, 70)}  cov=${cov}  ${sc.acquisition}`);
    out.push(`     sha ${sc.sha256.slice(0, 12)}  ${sc.bytes} B  tells=${sc.staticReport.summary.botDetectionTells}`);
  }
  out.push("");

  // ─── findings ────────────────────────────────────────────────────
  const findings = report.findings.filter((f) => SEV_ORDER[f.api.severity]! >= minSev);
  out.push(c.bold(`findings (${findings.length})`));
  for (const f of findings) {
    out.push(formatFinding(f, c, maxHits));
  }

  return out.join("\n");
}

function formatFinding(f: AnnotatedFinding, c: ColorFns, maxHits: number): string {
  const sev = f.api.severity.toUpperCase().padEnd(6);
  const prov = f.provenance === "static+runtime"
    ? c.green("BOTH")
    : f.provenance === "runtime"
      ? c.yellow("RT  ")
      : c.dim("STAT");
  const tell = f.api.botDetectionTell ? c.red(" TELL") : "";
  const lines: string[] = [];
  lines.push(`[${prov}] ${sevColor(c, f.api.severity, sev)} ${f.api.key} ×${f.count}${tell}`);
  lines.push(`     ${c.dim(f.api.description)}`);
  if (f.provenance !== "static" && f.callSites > 0) {
    lines.push(`     ${c.dim(`runtime call sites: ${f.callSites}`)}`);
    for (const stack of f.sampleStacks.slice(0, 2)) {
      lines.push(`       ${c.dim(stack.split("\n")[0] ?? "")}`);
    }
  }
  if (f.api.evasion) lines.push(`     ${c.dim(`evasion: ${f.api.evasion}`)}`);
  let shown = 0;
  for (const hit of f.hits) {
    if (shown++ >= maxHits) break;
    const loc = hit.loc ? `${hit.loc.start.line}:${hit.loc.start.column}` : "—";
    lines.push(`       · ${loc.padEnd(10)} ${truncate(hit.snippet, 100)}`);
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

interface ColorFns {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
}

function makeColor(enabled: boolean): ColorFns {
  if (!enabled) {
    const id = (s: string) => s;
    return { bold: id, dim: id, red: id, yellow: id, green: id };
  }
  return {
    bold: (s) => `\x1b[1m${s}\x1b[22m`,
    dim: (s) => `\x1b[2m${s}\x1b[22m`,
    red: (s) => `\x1b[31m${s}\x1b[39m`,
    yellow: (s) => `\x1b[33m${s}\x1b[39m`,
    green: (s) => `\x1b[32m${s}\x1b[39m`,
  };
}

function sevColor(c: ColorFns, sev: string, s: string): string {
  if (sev === "high") return c.red(s);
  if (sev === "medium") return c.yellow(s);
  return s;
}
