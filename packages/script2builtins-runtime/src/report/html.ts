/**
 * Render a {@link RuntimeReport} as a stand-alone `index.html`.
 *
 * The HTML is **fully self-contained** — no remote scripts, no fonts,
 * no images. The CSS is inlined. Everything in the file resolves
 * relative to the file itself, so the entire `--out` directory can be
 * `scp`'d, attached to a ticket, or zipped without breaking.
 *
 * Sections shipped:
 *
 *   - Banner: target / runId / harness / trap-script sha (linkable so
 *     two reports can be eyeball-compared).
 *   - Summary: the same counts that ship in `report.txt` + a small
 *     red/yellow flag block for buffer overflows.
 *   - Findings table: sorted by severity, every row links to the
 *     per-script report when available.
 *   - Network sinks table.
 *   - Per-script bundle: each row links to the on-disk source under
 *     `scripts/`.
 *
 * Output is deliberately plain HTML5 — no framework, no build step.
 * The browser's default styling plus 30 lines of inline CSS is enough
 * for a forensic doc.
 */
import type { RuntimeReport, AnnotatedFinding } from "../types.js";
import type { NetworkSink } from "script2builtins/types";

export interface HtmlIndexOptions {
  /** Optional path to the text report (relative to the HTML). */
  textReportHref?: string;
  /** Optional path to the JSON report (relative to the HTML). */
  jsonReportHref?: string;
}

export function renderHtmlIndex(report: RuntimeReport, opts: HtmlIndexOptions = {}): string {
  const out: string[] = [];
  out.push("<!doctype html>");
  out.push('<html lang="en"><head>');
  out.push('<meta charset="utf-8">');
  out.push(`<title>${esc(`s2b run · ${report.target || report.runId}`)}</title>`);
  out.push("<style>", CSS, "</style>");
  out.push("</head><body>");

  // ── header ──────────────────────────────────────────────────────
  out.push('<header class="hdr">');
  out.push("<h1>script2builtins-runtime</h1>");
  out.push('<dl class="meta">');
  out.push(`<dt>target</dt><dd>${esc(report.target || "-")}</dd>`);
  out.push(`<dt>run id</dt><dd><code>${esc(report.runId)}</code></dd>`);
  out.push(
    `<dt>started / ended</dt><dd>${esc(report.startedAt)} → ${esc(report.endedAt)}</dd>`,
  );
  out.push(`<dt>harness</dt><dd>${esc(report.harnessMode)}</dd>`);
  out.push(
    `<dt>catalog</dt><dd><code>${esc(report.catalogVersion)}</code> · trap <code>${esc(report.trapScriptSha256.slice(0, 16))}…</code></dd>`,
  );
  if (report.stealthScriptSha256) {
    out.push(
      `<dt>stealth</dt><dd><code>${esc(report.stealthScriptSha256.slice(0, 16))}…</code></dd>`,
    );
  }
  if (report.navError) {
    out.push(
      `<dt class="warn">nav error</dt><dd class="warn">${esc(report.navError)}</dd>`,
    );
  }
  out.push("</dl>");

  // Companion artifact links.
  const links: string[] = [];
  if (opts.jsonReportHref)
    links.push(`<a href="${esc(opts.jsonReportHref)}">report.json</a>`);
  if (opts.textReportHref)
    links.push(`<a href="${esc(opts.textReportHref)}">report.txt</a>`);
  if (links.length > 0) {
    out.push(`<p class="links">${links.join(" · ")}</p>`);
  }
  out.push("</header>");

  // ── summary ─────────────────────────────────────────────────────
  const s = report.summary;
  out.push("<section><h2>summary</h2>");
  out.push('<table class="kv">');
  row(out, "scripts captured", `${s.totalScripts}  (network ${s.networkScripts}, inline ${s.inlineScripts}, srcdoc ${s.srcdocScripts}, eval ${s.evalScripts})`);
  row(out, "accesses (runtime/static)", `${s.totalAccesses}  (rt ${s.runtimeAccesses}, st ${s.staticAccesses})`);
  row(out, "known fingerprint APIs", String(s.knownAccesses));
  row(out, "bot-detection tells", String(s.botDetectionTells));
  row(out, "network sinks", String(s.sinkCount));
  row(out, "fingerprints exfiltrated", String(s.leakedApiCount));
  row(out, "runtime categories", s.runtimeCategories.join(", ") || "-");
  if (s.bufferOverflows > 0) {
    const bk = s.bufferOverflowsByKind;
    rowWarn(
      out,
      "buffer overflows",
      `${s.bufferOverflows}  (access ${bk.access}, sink ${bk.sink}, hazard ${bk.hazard})`,
    );
  }
  if (s.preExistingPages > 0) {
    rowWarn(out, "pre-existing pages", `${s.preExistingPages} (not instrumented)`);
  }
  out.push("</table></section>");

  // ── gap analysis ────────────────────────────────────────────────
  if (s.runtimeOnlyKeys.length > 0) {
    out.push("<section><h2>runtime-only keys</h2>");
    out.push("<p>Cataloged surfaces that fired at runtime but never appeared in any static scan. These are the eval / dynamic-key / Reflect path keys.</p>");
    out.push(`<ul class="cols">${s.runtimeOnlyKeys.map((k) => `<li><code>${esc(k)}</code></li>`).join("")}</ul>`);
    out.push("</section>");
  }

  // ── findings ────────────────────────────────────────────────────
  out.push("<section><h2>findings</h2>");
  out.push('<table class="findings"><thead><tr>');
  out.push("<th>sev</th><th>key</th><th>category</th><th>count</th><th>callSites</th><th>provenance</th>");
  out.push("</tr></thead><tbody>");
  for (const f of report.findings) {
    out.push(renderFindingRow(f));
  }
  out.push("</tbody></table></section>");

  // ── sinks ───────────────────────────────────────────────────────
  if (report.reconstructedSinks.length > 0) {
    out.push("<section><h2>network sinks</h2>");
    out.push('<table class="sinks"><thead><tr>');
    out.push("<th>kind</th><th>method</th><th>url</th><th>provider</th><th>originating script</th>");
    out.push("</tr></thead><tbody>");
    for (const s of report.reconstructedSinks) {
      out.push(renderSinkRow(s));
    }
    out.push("</tbody></table></section>");
  }

  // ── per-script bundle ───────────────────────────────────────────
  if (report.scripts.length > 0) {
    out.push("<section><h2>captured scripts</h2>");
    out.push('<table class="scripts"><thead><tr>');
    out.push("<th>name</th><th>sha (12)</th><th>bytes</th><th>acquisition</th><th>coverage</th><th>tells</th><th>source</th>");
    out.push("</tr></thead><tbody>");
    for (const sc of report.scripts) {
      const href = sc.savedTo ? relativizeSaved(sc.savedTo) : null;
      const cov = `${(sc.trapCoverage * 100).toFixed(0)}%`;
      const tells = sc.staticReport.summary.botDetectionTells;
      out.push(
        `<tr>` +
          `<td>${esc(truncate(sc.name, 80))}</td>` +
          `<td><code>${esc(sc.sha256.slice(0, 12))}</code></td>` +
          `<td class="r">${sc.bytes}</td>` +
          `<td>${esc(sc.acquisition)}</td>` +
          `<td class="r">${cov}</td>` +
          `<td class="r">${tells > 0 ? `<strong>${tells}</strong>` : "0"}</td>` +
          `<td>${href ? `<a href="${esc(href)}">file</a>` : "-"}</td>` +
          `</tr>`,
      );
    }
    out.push("</tbody></table></section>");
  }

  out.push("</body></html>");
  return out.join("\n");
}

function renderFindingRow(f: AnnotatedFinding): string {
  const sevClass = `sev sev-${f.api.severity}`;
  return (
    `<tr>` +
    `<td><span class="${sevClass}">${esc(f.api.severity)}</span></td>` +
    `<td><code>${esc(f.api.key)}</code></td>` +
    `<td>${esc(f.api.category)}</td>` +
    `<td class="r">${f.count}</td>` +
    `<td class="r">${f.callSites}</td>` +
    `<td>${esc(f.provenance)}</td>` +
    `</tr>`
  );
}

function renderSinkRow(s: NetworkSink): string {
  return (
    `<tr>` +
    `<td>${esc(s.kind)}</td>` +
    `<td>${esc(s.method ?? "-")}</td>` +
    `<td><code>${esc(s.url ?? s.urlSnippet ?? "<dynamic>")}</code></td>` +
    `<td>${s.provider ? `<strong>${esc(s.provider)}</strong>` : "-"}</td>` +
    `<td><code>${esc(s.originatingScriptSha256 ? s.originatingScriptSha256.slice(0, 12) : "-")}</code></td>` +
    `</tr>`
  );
}

function row(out: string[], k: string, v: string): void {
  out.push(`<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`);
}

function rowWarn(out: string[], k: string, v: string): void {
  out.push(`<tr class="warn"><th>${esc(k)}</th><td>${esc(v)}</td></tr>`);
}

/**
 * Saved paths are absolute on disk. The index lives alongside them in
 * `outDir`, so we strip the outDir prefix (best-effort by looking for
 * the last `/scripts/` or `/evals/` or `/wasm/` segment).
 */
function relativizeSaved(absPath: string): string {
  const m = /\/(scripts|evals|wasm)\/[^/]+$/.exec(absPath);
  if (m) return `.${absPath.slice(m.index)}`;
  // Fallback: basename.
  const i = absPath.lastIndexOf("/");
  return i >= 0 ? `./${absPath.slice(i + 1)}` : absPath;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

const CSS = `
:root { --fg: #1d2025; --fg-dim: #6a7280; --bg: #fcfcfd; --bg-alt: #f4f5f7; --border: #d8dbe1; --warn: #b54100; --high: #d33; --med: #c80; --low: #a5a200; --info: #5a7a8b; }
body { font: 13.5px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 0 24px 64px; }
.hdr { padding: 20px 0 12px; border-bottom: 1px solid var(--border); }
.hdr h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
.hdr dl.meta { margin: 0; display: grid; grid-template-columns: 140px 1fr; gap: 2px 16px; }
.hdr dl.meta dt { color: var(--fg-dim); font-weight: 500; }
.hdr dl.meta dd { margin: 0; word-break: break-all; }
.hdr p.links { margin: 10px 0 0; }
.hdr p.links a { margin-right: 8px; }
section { margin: 28px 0; }
section h2 { font-size: 15px; font-weight: 600; margin: 0 0 10px; padding: 0 0 4px; border-bottom: 1px solid var(--border); }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { padding: 5px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--bg-alt); }
th { color: var(--fg-dim); font-weight: 500; }
td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
table.kv th { width: 220px; font-weight: 500; color: var(--fg-dim); }
table.kv tr.warn td, table.kv tr.warn th { color: var(--warn); }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
ul.cols { columns: 3 280px; padding-left: 18px; }
ul.cols li { break-inside: avoid; margin: 0 0 2px; }
.sev { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.sev-high { background: #fdecec; color: var(--high); }
.sev-medium { background: #fff5e6; color: var(--med); }
.sev-low { background: #fafadb; color: var(--low); }
.sev-info { background: #eaf2f7; color: var(--info); }
.warn { color: var(--warn); }
a { color: #2a5cd1; }
`;
