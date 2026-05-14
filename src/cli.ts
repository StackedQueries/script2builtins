#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { analyze } from "./index.js";
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
    const source = await readStdin();
    inputs.push({ name: "<stdin>", source });
  }
  for (const f of flags.files) {
    const source = await readFile(f, "utf8");
    inputs.push({ name: basename(f), source });
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
  return "script2builtins 0.1.0";
}

main().catch((err: unknown) => {
  process.stderr.write(`script2builtins: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
