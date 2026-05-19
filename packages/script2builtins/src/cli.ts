#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "./index.js";
import { parse } from "./analyze/parse.js";
import { renderText } from "./report/text.js";
import type { Severity } from "./types.js";

interface CliFlags {
  format: "text" | "json";
  minSeverity: Severity;
  categories: string[] | null;
  showHits: boolean;
  maxHitsPerFinding: number;
  includeUnknown: boolean;
  noColor: boolean;
  sourceType?: "script" | "module";
  hideSinks: boolean;
  sinksOnly: boolean;
  files: string[];
  fromStdin: boolean;
  help: boolean;
  version: boolean;
  /** Hard cap on input size in bytes (truncate to this). Null = no cap. */
  maxBytes: number | null;
  /** When true, only run the parser and report parse status. */
  parseOnly: boolean;
}

const HELP = `script2builtins — forensic analyzer for fingerprinting JS

Usage:
  script2builtins [options] <file...>
  cat script.js | script2builtins [options] -

Options:
  --json                       Emit a single JSON report (array if multiple files).
  --text                       Force text output (default when stdout is a TTY).
  --min-severity LEVEL         high | medium | low | info  (default: info)
  --category NAME[,NAME...]    Restrict findings to these categories.
  --no-hits                    Hide per-finding source evidence.
  --max-hits N                 Cap evidence rows per finding (default 5).
  --max-bytes N                Truncate each input to N bytes before parsing.
  --parse-only                 Only run the parser; emit a one-line ok/fail.
  --include-unknown            Emit unmatched accesses too (noisy).
  --no-color                   Disable ANSI colours.
  --source-type script|module  Force parse mode.
  --no-sinks                   Hide the network-sinks section.
  --sinks-only                 Show only the network-sinks section + summary.
  -h, --help
  -v, --version

The report tells you which JS builtins and browser APIs the script touches,
grouped by fingerprint category, with a per-API note on what detectors are
inferring and how it is typically evaded. The goal: rapid forensics on
opaque bot-detection blobs (Akamai, DataDome, PerimeterX, Cloudflare, custom).
`;

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    format: process.stdout.isTTY ? "text" : "text",
    minSeverity: "info",
    categories: null,
    showHits: true,
    maxHitsPerFinding: 5,
    includeUnknown: false,
    noColor: !process.stdout.isTTY,
    hideSinks: false,
    sinksOnly: false,
    files: [],
    fromStdin: false,
    help: false,
    version: false,
    maxBytes: null,
    parseOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    switch (a) {
      case "-h":
      case "--help":
        flags.help = true;
        break;
      case "-v":
      case "--version":
        flags.version = true;
        break;
      case "--json":
        flags.format = "json";
        break;
      case "--text":
        flags.format = "text";
        break;
      case "--no-hits":
        flags.showHits = false;
        break;
      case "--include-unknown":
        flags.includeUnknown = true;
        break;
      case "--no-color":
      case "--no-colour":
        flags.noColor = true;
        break;
      case "--no-sinks":
        flags.hideSinks = true;
        break;
      case "--sinks-only":
        flags.sinksOnly = true;
        break;
      case "--parse-only":
        flags.parseOnly = true;
        break;
      case "--max-bytes": {
        const v = argv[++i];
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) die(`--max-bytes expects a positive integer, got ${v}`);
        flags.maxBytes = Math.floor(n);
        break;
      }
      case "--min-severity": {
        const v = argv[++i];
        if (!isSeverity(v)) die(`--min-severity expects high|medium|low|info, got ${v}`);
        flags.minSeverity = v;
        break;
      }
      case "--category": {
        const v = argv[++i];
        if (!v) die("--category requires a value");
        flags.categories = v.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--max-hits": {
        const v = argv[++i];
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) die(`--max-hits expects a non-negative number, got ${v}`);
        flags.maxHitsPerFinding = n;
        break;
      }
      case "--source-type": {
        const v = argv[++i];
        if (v !== "script" && v !== "module") die(`--source-type expects script|module, got ${v}`);
        flags.sourceType = v;
        break;
      }
      case "-": {
        flags.fromStdin = true;
        break;
      }
      default: {
        if (a.startsWith("--min-severity=")) {
          const v = a.slice("--min-severity=".length);
          if (!isSeverity(v)) die(`--min-severity expects high|medium|low|info, got ${v}`);
          flags.minSeverity = v;
          break;
        }
        if (a.startsWith("--category=")) {
          flags.categories = a.slice("--category=".length).split(",").map((s) => s.trim()).filter(Boolean);
          break;
        }
        if (a.startsWith("--max-hits=")) {
          const n = Number(a.slice("--max-hits=".length));
          if (!Number.isFinite(n) || n < 0) die(`--max-hits expects a non-negative number, got ${a}`);
          flags.maxHitsPerFinding = n;
          break;
        }
        if (a.startsWith("--source-type=")) {
          const v = a.slice("--source-type=".length);
          if (v !== "script" && v !== "module") die(`--source-type expects script|module, got ${v}`);
          flags.sourceType = v;
          break;
        }
        if (a.startsWith("--max-bytes=")) {
          const n = Number(a.slice("--max-bytes=".length));
          if (!Number.isFinite(n) || n <= 0) die(`--max-bytes expects a positive integer, got ${a}`);
          flags.maxBytes = Math.floor(n);
          break;
        }
        if (a.startsWith("-")) die(`unknown flag: ${a}`);
        flags.files.push(a);
      }
    }
  }
  return flags;
}

function isSeverity(v: string | undefined): v is Severity {
  return v === "high" || v === "medium" || v === "low" || v === "info";
}

function die(msg: string): never {
  process.stderr.write(`script2builtins: ${msg}\n`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (flags.version) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }

  const wantStdin = flags.fromStdin || (flags.files.length === 0 && !process.stdin.isTTY);
  if (!wantStdin && flags.files.length === 0) {
    process.stdout.write(HELP);
    process.exit(1);
  }

  const inputs: { name: string; source: string }[] = [];
  if (wantStdin) {
    const source = applyMaxBytes(await readStdin(), flags.maxBytes);
    inputs.push({ name: "<stdin>", source });
  }
  for (const f of flags.files) {
    const source = applyMaxBytes(await readFile(f, "utf8"), flags.maxBytes);
    inputs.push({ name: basename(f), source });
  }

  // --parse-only short-circuits the full pipeline. Useful for validating
  // that a 1-3MB Cloudflare / DataDome blob actually parses before
  // paying the walk cost.
  if (flags.parseOnly) {
    let exitCode = 0;
    const summaries = inputs.map((input) => {
      const { info } = parse(input.source, flags.sourceType);
      if (!info.ok) exitCode = 1;
      return {
        name: input.name,
        bytes: Buffer.byteLength(input.source, "utf8"),
        parse: info,
      };
    });
    if (flags.format === "json") {
      const payload = summaries.length === 1 ? summaries[0] : summaries;
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      for (const s of summaries) {
        const status = s.parse.ok ? `ok (${s.parse.sourceType})` : "FAILED";
        process.stdout.write(`${s.name}\t${s.bytes}B\t${status}\n`);
        if (!s.parse.ok) for (const e of s.parse.errors) process.stdout.write(`  ! ${e}\n`);
      }
    }
    process.exit(exitCode);
  }

  const reports = inputs.map((input) =>
    analyze(input.source, {
      name: input.name,
      sourceType: flags.sourceType,
      includeUnknown: flags.includeUnknown,
    }),
  );

  if (flags.format === "json") {
    const payload = reports.length === 1 ? reports[0] : reports;
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  let exitCode = 0;
  for (let i = 0; i < reports.length; i++) {
    const report = reports[i];
    if (!report) continue;
    if (i > 0) process.stdout.write("\n" + "─".repeat(60) + "\n\n");
    process.stdout.write(
      renderText(report, {
        showHits: flags.showHits,
        maxHitsPerFinding: flags.maxHitsPerFinding,
        minSeverity: flags.minSeverity,
        categories: flags.categories ?? undefined,
        noColor: flags.noColor,
        hideSinks: flags.hideSinks,
        sinksOnly: flags.sinksOnly,
      }) + "\n",
    );
    if (!report.parse.ok) exitCode = 1;
  }
  process.exit(exitCode);
}

function getVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(path.join(here, "..", "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    return `${pkg.name ?? "script2builtins"} ${pkg.version ?? "unknown"}`;
  } catch {
    return "script2builtins unknown";
  }
}

/**
 * Truncate `source` to `max` bytes (UTF-8). Returns the original string
 * when `max` is null or the source already fits.
 *
 * We slice on a byte boundary, not a code-point boundary, because the
 * intent of `--max-bytes` is "bound a runaway input" — losing the
 * trailing partial code point is preferable to scanning the whole
 * string. The parser will fall back to script mode on the truncated
 * tail when the truncation happens mid-token.
 */
function applyMaxBytes(source: string, max: number | null): string {
  if (max === null) return source;
  const buf = Buffer.from(source, "utf8");
  if (buf.length <= max) return source;
  return buf.subarray(0, max).toString("utf8");
}

main().catch((err: unknown) => {
  process.stderr.write(`script2builtins: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
