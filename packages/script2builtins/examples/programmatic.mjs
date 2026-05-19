// Programmatic usage of script2builtins — drop in any Node 18+ project.
//
//   node examples/programmatic.mjs path/to/detector.js
//
// Walks every cataloged API the script touches, then prints a focused
// "what gets exfiltrated and where" summary you can pipe into anything.

import { readFile } from "node:fs/promises";
import { analyze, ALL_APIS } from "../dist/index.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: node examples/programmatic.mjs <file.js>");
  process.exit(2);
}

const source = await readFile(file, "utf8");
const report = analyze(source, { name: file });

console.log(`# ${report.source.name} — ${report.source.bytes} bytes`);
console.log(
  `  ${report.findings.length} findings · ${report.summary.botDetectionTells} bot tells · ${report.summary.sinkCount} sinks · ${report.summary.leakedApiCount} fingerprints exfiltrated\n`,
);

console.log("## Strong tells (severity high, botDetectionTell)");
for (const f of report.findings) {
  if (f.api.severity !== "high" || !f.api.botDetectionTell) continue;
  console.log(`  • ${f.api.key} ×${f.count} — ${f.api.description}`);
  if (f.api.evasion) console.log(`      evasion: ${f.api.evasion}`);
}

console.log("\n## Network sinks");
for (const sink of report.networkSinks) {
  const url = sink.url ?? sink.urlSnippet ?? "?";
  console.log(`  ${sink.kind.padEnd(15)} ${(sink.method ?? "").padEnd(5)} ${url}`);
  for (const e of sink.payload?.entries ?? []) {
    if (e.leakedApi) {
      console.log(`      ${e.key.padEnd(20)} → ${e.leakedApi.key}  [${e.leakedApi.category}]`);
    }
  }
}

console.log(`\n## Catalog size: ${ALL_APIS.length} entries across ${new Set(ALL_APIS.map((a) => a.category)).size} categories`);
