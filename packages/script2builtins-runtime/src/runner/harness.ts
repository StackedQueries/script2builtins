/**
 * Wrap a local JS file in an HTML harness and drive it through {@link run}.
 *
 * Three flavors picked via `harnessMode`:
 *
 *   - `"data"`     — base64 `data:` URL. Origin is opaque, so
 *                    `localStorage`/cookies/`indexedDB` behave
 *                    differently than on a real site. Cheapest and
 *                    zero-dependency. Default.
 *   - `"file"`     — `file://` URL. Same opaque-origin caveats as
 *                    `data:`, but allows relative imports inside the
 *                    file to resolve from disk.
 *   - `"http-harness"` — spin up a localhost HTTP server, serve the
 *                    harness HTML there, navigate to it. The page has
 *                    a real `http://` origin so storage APIs work and
 *                    same-origin fetches behave normally. We stop the
 *                    server as soon as `run()` returns.
 *
 * In every mode the script bytes are embedded via `<script src="data:…">`
 * — see {@link buildHarnessHtml} for the rationale (the HTML parser
 * cannot terminate base64 content).
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import type { RunOptions, RuntimeReport } from "../types.js";
import { run } from "./driver.js";

export interface RunHarnessOptions extends Omit<RunOptions, "url"> {
  /**
   * How to serve the harness. Default `"data"`. Use `"http-harness"`
   * when the script needs a real same-origin (cookies, localStorage).
   */
  harnessMode?: "data" | "file" | "http-harness";
  /** Port for `"http-harness"` mode. Default: ephemeral. */
  port?: number;
}

export async function runHarness(
  filePath: string,
  opts: RunHarnessOptions = { outDir: "." },
): Promise<RuntimeReport> {
  const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
  let source: string;
  try {
    source = await readFile(abs, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`runHarness: cannot read ${abs} (${msg})`);
  }

  const mode = opts.harnessMode ?? "data";
  const html = buildHarnessHtml(source);

  if (mode === "data") {
    const url = `data:text/html;base64,${Buffer.from(html, "utf8").toString("base64")}`;
    return run({ ...opts, url, harnessMode: "data" });
  }

  if (mode === "file") {
    const tmp = await mkdtemp(join(tmpdir(), "s2b-harness-"));
    const htmlPath = join(tmp, "index.html");
    await writeFile(htmlPath, html, "utf8");
    try {
      return await run({ ...opts, url: `file://${htmlPath}`, harnessMode: "file" });
    } finally {
      try {
        await rm(tmp, { recursive: true, force: true });
      } catch {
        // Best effort — leaking a temp file is preferable to crashing
        // the caller mid-run.
      }
    }
  }

  // http-harness — real http://localhost origin.
  const server = await startLocalHarness(html, opts.port);
  const url = `http://127.0.0.1:${server.port}/`;
  try {
    return await run({ ...opts, url, harnessMode: "http-harness" });
  } finally {
    await new Promise<void>((res) => server.server.close(() => res()));
  }
}

interface HarnessServer {
  server: Server;
  port: number;
}

function startLocalHarness(html: string, port: number | undefined): Promise<HarnessServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Single-route server: every GET returns the harness HTML.
      // POST/etc. respond 204 so trap-side beacons don't crash the
      // page with a network error. Other methods 405.
      if (req.method === "GET" || req.method === "HEAD") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // Aggressively no-cache so reload behaviour matches the
          // expectation for one-shot runs.
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? "" : html);
        return;
      }
      if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
        // Drain the body so the socket can be closed cleanly.
        req.resume();
        req.on("end", () => {
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(405).end();
    });
    server.on("error", reject);
    server.listen(port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("startLocalHarness: failed to bind"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

/**
 * Build the harness HTML. The script source is embedded via
 * `<script src="data:text/javascript;base64,…">` so the HTML parser
 * cannot terminate it via `</script>` inside the source. See the
 * test suite for malicious-input cases this protects against.
 */
export function buildHarnessHtml(source: string): string {
  const scriptDataUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>s2b harness</title></head>',
    "<body>",
    `<script src="${scriptDataUrl}"></script>`,
    "</body></html>",
  ].join("\n");
}

