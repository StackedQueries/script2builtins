#!/usr/bin/env node
/**
 * s2b — unified CLI. Dispatches on input shape:
 *
 *   s2b detector.js                     → static analysis (no browser)
 *   s2b -                               → static, source from stdin
 *   s2b detector.js --dynamic           → wrap in HTML harness, drive in browser
 *   s2b https://example.com/            → dynamic on URL (+ auto-static on every
 *                                          captured script)
 *   s2b https://example.com/fp.js --static-only
 *                                       → fetch URL, run static, no browser
 *   s2b diff <reportA.json> <reportB.json>
 *                                       → compare two runtime reports
 *
 * Flags shared with both modes:
 *   --json                              machine-readable output
 *   --out <dir>                         output directory (default runs/<ts>)
 *   --min-severity <info|low|medium|high>
 *   --no-color
 *
 * Dynamic-only flags:
 *   --headless                          run without a visible browser
 *   --nav-timeout <ms>                  default 30000
 *   --idle <ms>                         default 10000
 *   --ua "<user-agent>"
 *   --stealth                           install navigator-shim before the trap
 *
 * Static-only flags:
 *   --include-unknown                   emit accesses we extracted but didn't catalog
 *   --max-hits <N>                      cap evidence rows per finding (default 5)
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface Args {
  input: string | "-" | null;
  mode: "static" | "dynamic" | "static-from-url" | null;
  json: boolean;
  outDir: string | null;
  headless: boolean;
  navTimeoutMs: number;
  idleMs: number;
  userAgent: string | null;
  minSeverity: "info" | "low" | "medium" | "high";
  includeUnknown: boolean;
  maxHits: number;
  noColor: boolean;
  help: boolean;
  harnessMode: "data" | "file" | "http-harness";
  trapReflectGet: boolean;
  stealth: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    input: null,
    mode: null,
    json: false,
    outDir: null,
    headless: process.env.HEADLESS === "1",
    navTimeoutMs: 30_000,
    idleMs: 10_000,
    userAgent: null,
    minSeverity: "info",
    includeUnknown: false,
    maxHits: 5,
    noColor: !process.stdout.isTTY,
    help: false,
    harnessMode: "data",
    trapReflectGet: true,
    stealth: false,
  };
  let forceStatic = false;
  let forceDynamic = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === "--help" || v === "-h") a.help = true;
    else if (v === "--dynamic") forceDynamic = true;
    else if (v === "--static-only" || v === "--static") forceStatic = true;
    else if (v === "--json") a.json = true;
    else if (v === "--no-color") a.noColor = true;
    else if (v === "--headless") a.headless = true;
    else if (v === "--include-unknown") a.includeUnknown = true;
    else if (v === "--out") a.outDir = takeValue(argv, ++i, v);
    else if (v === "--nav-timeout") a.navTimeoutMs = takePositiveInt(argv, ++i, v, { min: 1 });
    else if (v === "--idle") a.idleMs = takePositiveInt(argv, ++i, v, { min: 0 });
    else if (v === "--ua") a.userAgent = takeValue(argv, ++i, v);
    else if (v === "--min-severity") {
      const m = takeValue(argv, ++i, v);
      if (m === "info" || m === "low" || m === "medium" || m === "high") a.minSeverity = m;
      else die(`unknown --min-severity: ${m}`);
    } else if (v === "--max-hits") a.maxHits = takePositiveInt(argv, ++i, v, { min: 0 });
    else if (v === "--trap-reflect-get") a.trapReflectGet = true;
    else if (v === "--no-trap-reflect-get") a.trapReflectGet = false;
    else if (v === "--stealth") a.stealth = true;
    else if (v === "--no-stealth") a.stealth = false;
    else if (v === "--harness-mode") {
      const m = takeValue(argv, ++i, v);
      if (m === "data" || m === "file" || m === "http-harness") a.harnessMode = m;
      else die(`--harness-mode must be one of data|file|http-harness, got ${JSON.stringify(m)}`);
    }
    else if (v.startsWith("--")) die(`unknown flag: ${v}`);
    else if (a.input === null) a.input = v;
    else die(`unexpected positional: ${v}`);
  }

  if (a.help || a.input === null) {
    a.mode = null;
    return a;
  }

  const isUrl = a.input !== "-" && /^https?:\/\//i.test(a.input);
  if (isUrl) {
    a.mode = forceStatic ? "static-from-url" : "dynamic";
  } else {
    // file or stdin
    a.mode = forceDynamic ? "dynamic" : "static";
  }
  if (forceStatic && forceDynamic) die("--static and --dynamic are mutually exclusive");
  return a;
}

function die(msg: string): never {
  process.stderr.write(`s2b: ${msg}\n`);
  process.exit(2);
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) die(`${flag} requires a value`);
  return v;
}

function takePositiveInt(
  argv: string[],
  i: number,
  flag: string,
  bounds: { min: number },
): number {
  const raw = argv[i];
  if (raw === undefined) die(`${flag} requires a value`);
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    die(`${flag} expects an integer, got ${JSON.stringify(raw)}`);
  }
  if (n < bounds.min) die(`${flag} must be ≥ ${bounds.min}, got ${n}`);
  return n;
}

function printHelp() {
  process.stdout.write(
    [
      "s2b — script2builtins unified CLI (static + dynamic)",
      "",
      "  s2b <file|->                      static analysis",
      "  s2b <file> --dynamic              wrap file in HTML harness, drive in browser",
      "  s2b <url>                         dynamic analysis (browser + traps + auto-static)",
      "  s2b <url> --static-only           fetch URL, run static, no browser",
      "  s2b diff <A.json> <B.json>        compare two runtime reports",
      "",
      "Common flags:",
      "  --json                            machine-readable output",
      "  --out <dir>                       output directory (default runs/<timestamp>)",
      "  --min-severity info|low|medium|high",
      "  --no-color                        strip ANSI",
      "",
      "Dynamic-only flags:",
      "  --headless                        run without a visible browser",
      "  --nav-timeout <ms>                navigation timeout (default 30000)",
      "  --idle <ms>                       post-navigation idle (default 10000)",
      "  --ua \"<user-agent>\"               override the User-Agent header",
      "  --harness-mode data|file|http-harness",
      "                                    file-mode harness origin (default data)",
      "                                    http-harness: real http://127.0.0.1 origin",
      "  --no-trap-reflect-get             skip the Reflect.get wrapper (default: on; pass for hot pages)",
      "  --stealth                         install navigator/webdriver/plugins/permissions shim (default: off)",
      "                                    see docs/stealth-mode.md for the matrix",
      "",
      "Static-only flags:",
      "  --include-unknown                 also emit uncataloged accesses",
      "  --max-hits <N>                    cap evidence rows per finding (default 5)",
      "",
      "Exit codes: 0 ok · 1 analysis or runtime error · 2 argument error",
      "",
    ].join("\n"),
  );
}

async function readSourceFrom(input: string): Promise<{ name: string; source: string }> {
  if (input === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return { name: "<stdin>", source: Buffer.concat(chunks).toString("utf8") };
  }
  const abs = resolve(process.cwd(), input);
  if (!existsSync(abs)) die(`file not found: ${input}`);
  return { name: input, source: await readFile(abs, "utf8") };
}

function defaultOutDir(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(process.cwd(), "runs", ts);
}

async function main() {
  // `s2b diff` is its own subcommand — parsed independently from the
  // main static/dynamic flow because its positional shape (two files)
  // doesn't fit `parseArgs`. Anything before `diff` other than --help
  // / --no-color is rejected.
  const argv = process.argv.slice(2);
  const diffIdx = argv.indexOf("diff");
  if (diffIdx === 0) {
    await runDiff(argv.slice(1));
    return;
  }

  const args = parseArgs(argv);
  if (args.help || args.mode === null) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }

  if (args.mode === "static") {
    const { analyze, renderText } = await import("script2builtins");
    const { name, source } = await readSourceFrom(args.input!);
    const report = analyze(source, { name, includeUnknown: args.includeUnknown });
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(
        renderText(report, {
          minSeverity: args.minSeverity,
          maxHitsPerFinding: args.maxHits,
          noColor: args.noColor,
        }) + "\n",
      );
    }
    return;
  }

  if (args.mode === "static-from-url") {
    const { analyzeUrl } = await import("./runner/analyze-url.js");
    const { renderText } = await import("script2builtins");
    const report = await analyzeUrl(args.input!, { includeUnknown: args.includeUnknown });
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(
        renderText(report, {
          minSeverity: args.minSeverity,
          maxHitsPerFinding: args.maxHits,
          noColor: args.noColor,
        }) + "\n",
      );
    }
    return;
  }

  // dynamic
  const outDir = args.outDir ?? defaultOutDir();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });

  const isFile = args.input !== "-" && !/^https?:\/\//i.test(args.input!);
  let report;
  try {
    if (isFile) {
      const { runHarness } = await import("./runner/harness.js");
      report = await runHarness(args.input!, {
        outDir,
        headless: args.headless,
        navTimeoutMs: args.navTimeoutMs,
        postNavIdleMs: args.idleMs,
        userAgent: args.userAgent ?? undefined,
        harnessMode: args.harnessMode,
        trapReflectGet: args.trapReflectGet,
        stealth: args.stealth,
      });
    } else {
      const { run } = await import("./runner/index.js");
      report = await run({
        url: args.input!,
        outDir,
        headless: args.headless,
        navTimeoutMs: args.navTimeoutMs,
        postNavIdleMs: args.idleMs,
        userAgent: args.userAgent ?? undefined,
        trapReflectGet: args.trapReflectGet,
        stealth: args.stealth,
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launch/.test(msg)) {
      process.stderr.write(
        "s2b: Chromium is not installed. Run:\n" +
          "    npx playwright install chromium\n" +
          "and re-run.\n",
      );
      process.exit(1);
    }
    throw err;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const { renderRuntimeText } = await import("./report/index.js");
    process.stdout.write(
      renderRuntimeText(report, {
        minSeverity: args.minSeverity,
        maxHitsPerFinding: args.maxHits,
        noColor: args.noColor,
      }) + "\n",
    );
  }
}

async function runDiff(args: string[]): Promise<void> {
  let json = false;
  let noColor = !process.stdout.isTTY;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i]!;
    if (v === "--json") json = true;
    else if (v === "--no-color") noColor = true;
    else if (v === "--help" || v === "-h") {
      process.stdout.write(
        [
          "s2b diff — compare two runtime reports",
          "",
          "  s2b diff <A.json> <B.json>",
          "",
          "  --json        emit machine-readable diff",
          "  --no-color    strip ANSI",
          "",
          "Reads two `report.json` files (as written by `s2b <url> --out`).",
          "Highlights new / removed findings, sinks, providers, and hazards.",
          "Flags catalog-version drift if A and B were produced by",
          "different catalog snapshots.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else if (v.startsWith("--")) die(`s2b diff: unknown flag: ${v}`);
    else positional.push(v);
  }
  if (positional.length !== 2) {
    die("s2b diff: exactly two report paths required (A then B)");
  }
  const [pa, pb] = positional as [string, string];
  const a = await loadReport(pa);
  const b = await loadReport(pb);
  const { diffReports, renderDiffText } = await import("./runner/diff.js");
  const diff = diffReports(
    { slug: basenameOf(pa), report: a },
    { slug: basenameOf(pb), report: b },
  );
  if (json) {
    process.stdout.write(JSON.stringify(diff, null, 2) + "\n");
  } else {
    process.stdout.write(renderDiffText(diff, { noColor }) + "\n");
  }
}

async function loadReport(path: string): Promise<any> {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) die(`report not found: ${path}`);
  try {
    const raw = await readFile(abs, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    die(`failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

main().catch((err) => {
  process.stderr.write(`s2b: ${err?.stack ?? err}\n`);
  process.exit(1);
});
