import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { attach, runHarness } from "../../src/index.js";

const FIXTURE = `
  // Direct property reads (Proxy root traps)
  const ua = navigator.userAgent;
  const wd = navigator.webdriver;

  // Computed key (still resolves through Proxy)
  const k = "userAgent";
  const ua2 = navigator[k];

  // fetch sink
  fetch("https://example.com/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ua, wd }),
  }).catch(() => { /* offline is fine */ });

  // postMessage on Window — cross-realm exfil pattern. The harness is a
  // single window so the message just bounces; the trap should still
  // capture the call with sinkKind "postmessage-send".
  window.postMessage({ type: "fp", ua, wd }, "*");

  // MessageChannel.port — port-based variant
  const _ch = new MessageChannel();
  _ch.port1.postMessage({ probe: ua2 });

  // D6: BroadcastChannel inbound. Two channels in the same origin —
  // bc1 sends, bc2 receives. Cover both addEventListener and onmessage
  // setter paths.
  const bc1 = new BroadcastChannel("s2b-test");
  const bc2 = new BroadcastChannel("s2b-test");
  const bc3 = new BroadcastChannel("s2b-test");
  bc2.addEventListener("message", (e) => { void e; });
  bc3.onmessage = (e) => { void e; };
  bc1.postMessage({ rcv: "hello-from-bc1", ua });
  // Give the microtask a beat to dispatch.

  // eval recursion
  eval("var fp = navigator.webdriver;");

  // setTimeout-string
  setTimeout("var x = navigator.userAgent;", 0);

  // Function ctor
  new Function("return navigator.webdriver")();
`;

let chromiumAvailable = true;
beforeAll(async () => {
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
  } catch {
    chromiumAvailable = false;
  }
});

describe.runIf = (cond: boolean) => (cond ? describe : describe.skip);

describe("runHarness end-to-end", () => {
  it.runIf(true)("captures runtime accesses, sinks, and hazards", async () => {
    if (!chromiumAvailable) {
      console.warn("[skip] Chromium not installed; run `npx playwright install chromium`");
      return;
    }
    const outDir = await mkdtemp(resolve(tmpdir(), "s2b-runtime-test-"));
    const fixtureFile = resolve(outDir, "fixture.js");
    const fs = await import("node:fs/promises");
    await fs.writeFile(fixtureFile, FIXTURE);

    try {
      const report = await runHarness(fixtureFile, {
        outDir,
        headless: true,
        postNavIdleMs: 1500,
        navTimeoutMs: 15_000,
      });

      // Reports schema
      expect(report.reportVersion).toBe("1.0.0");
      expect(report.catalogVersion).toMatch(/^script2builtins@/);
      expect(report.trapScriptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.harnessMode).toBe("data");

      // Static + runtime findings should both include navigator.userAgent
      const uaFinding = report.findings.find((f) => f.api.key === "navigator.userAgent");
      expect(uaFinding).toBeDefined();
      expect(uaFinding!.count).toBeGreaterThan(0);

      // The eval payload should appear as a synthesized script
      const evalScript = report.scripts.find((s) => s.acquisition === "eval");
      expect(evalScript).toBeDefined();
      expect(evalScript!.sha256).toMatch(/^[a-f0-9]{64}$/);

      // Hazards include eval / Function / setTimeout-string
      const hazardKinds = new Set(report.hazards.map((h) => h.kind));
      expect(hazardKinds.has("eval")).toBe(true);

      // Fetch sink captured with concrete URL
      const fetchSink = report.reconstructedSinks.find((s) => s.kind === "fetch");
      expect(fetchSink).toBeDefined();
      expect(fetchSink!.url).toBe("https://example.com/collect");
      expect(fetchSink!.method).toBe("POST");

      // D15: the sink carries a script-sha256 hash that resolves to a
      // captured script in report.scripts. The harness fixture is
      // loaded via `<script src="data:…">`; the data-URL inline
      // extractor pushes it through urlToSha so stack-trace
      // attribution works.
      expect(fetchSink!.originatingScriptSha256).toMatch(/^[a-f0-9]{64}$/);
      const capturedShas = new Set(report.scripts.map((s) => s.sha256));
      expect(capturedShas.has(fetchSink!.originatingScriptSha256!)).toBe(true);
      // The matched script should be the fixture itself (acquisition "inline").
      const originating = report.scripts.find((s) => s.sha256 === fetchSink!.originatingScriptSha256);
      expect(originating?.acquisition).toBe("inline");

      // D7: window.postMessage and MessageChannel.port.postMessage
      // should both be captured as "postmessage-send" sinks. Bodies are
      // JSON-serialized plain objects.
      const pms = report.reconstructedSinks.filter((s) => s.kind === "postmessage-send");
      expect(pms.length).toBeGreaterThanOrEqual(2);
      const windowPm = pms.find((s) => s.url === "*");
      expect(windowPm).toBeDefined();
      expect(windowPm!.payload?.shape).toBe("json");
      const portPm = pms.find((s) => s.url === "<MessagePort>");
      expect(portPm).toBeDefined();
      expect(portPm!.payload?.shape).toBe("json");
      // Each postMessage sink should also carry D15 provenance.
      for (const s of pms) {
        expect(s.originatingScriptSha256).toMatch(/^[a-f0-9]{64}$/);
      }

      // D8: crypto.subtle.digest call. Best-effort — secure-context
      // availability varies across origins. When present, the event
      // should carry the algorithm and a 64-byte preview.
      // D8 SubtleCrypto verification lives in its own describe block
      // below because data: URLs aren't secure contexts in modern
      // Chromium, so crypto.subtle is undefined here.

      // D6: BroadcastChannel inbound. bc2 (addEventListener path) and
      // bc3 (onmessage setter path) should each receive bc1's message,
      // yielding two broadcastchannel-message-recv sinks. bc1 itself
      // is the sender and doesn't receive its own message.
      const bcrecv = report.reconstructedSinks.filter((s) => s.kind === "broadcastchannel-message-recv");
      expect(bcrecv.length).toBeGreaterThanOrEqual(2);
      for (const s of bcrecv) {
        expect(s.url).toBe("broadcast:s2b-test");
        expect(s.payload?.shape).toBe("json");
      }

      // D12: linkable artifacts land alongside report.json. index.html
      // is the entry point a ticket-attached run uses; report.txt is
      // the plaintext companion for git diff / grep workflows.
      const { readFile, stat } = await import("node:fs/promises");
      const indexStat = await stat(resolve(outDir, "index.html"));
      expect(indexStat.isFile()).toBe(true);
      expect(indexStat.size).toBeGreaterThan(0);
      const indexHtml = await readFile(resolve(outDir, "index.html"), "utf8");
      expect(indexHtml.startsWith("<!doctype html>")).toBe(true);
      expect(indexHtml).toContain(report.trapScriptSha256.slice(0, 16));
      expect(indexHtml).toContain('href="./report.json"');
      const txtStat = await stat(resolve(outDir, "report.txt"));
      expect(txtStat.isFile()).toBe(true);
      expect(txtStat.size).toBeGreaterThan(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("attach against existing context", () => {
  it.runIf(true)("instruments pages opened after attach", async () => {
    if (!chromiumAvailable) return;
    const outDir = await mkdtemp(resolve(tmpdir(), "s2b-runtime-attach-"));
    try {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const session = await attach(context, { outDir });
      const page = await context.newPage();
      await page.goto(`data:text/html,<script>navigator.userAgent;navigator.webdriver;</script>`);
      await page.waitForTimeout(500);
      const r = await session.report({ flush: true });
      const keys = new Set(r.findings.map((f) => f.api.key));
      expect(keys.has("navigator.userAgent")).toBe(true);
      expect(keys.has("navigator.webdriver")).toBe(true);
      expect(r.summary.preExistingPages).toBe(0);
      await session.detach();
      await browser.close();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

const CRYPTO_FIXTURE = `
  (async () => {
    const bytes = new TextEncoder().encode("fingerprint:" + navigator.userAgent);
    await crypto.subtle.digest("SHA-256", bytes);

    // HMAC sign — exercises the sign() path with a different algorithm.
    const key = await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    await crypto.subtle.sign("HMAC", key, bytes);
  })().catch(() => { /* surface failures in the report, not the test */ });
`;

// 16-byte WASM module: magic + version + empty type section.
// Hand-rolled so we don't have to compile anything at test time.
const TINY_WASM_FIXTURE = `
  (async () => {
    // Magic (\\0asm) + version 1 + empty Type section header.
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d,  // \\0asm
      0x01, 0x00, 0x00, 0x00,  // version 1
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,  // type section: one func type () -> ()
    ]);
    // Exercise the non-streaming entry point. Streaming variants need
    // a real Response object — covered by the static check that the
    // trap installs them.
    await WebAssembly.compile(bytes);
  })().catch(() => { /* failures surface in the report, not the test */ });
`;

describe("D5 WebAssembly capture", () => {
  it.runIf(true)("captures compile() bytes as a script with acquisition=wasm", async () => {
    if (!chromiumAvailable) return;
    const outDir = await mkdtemp(resolve(tmpdir(), "s2b-runtime-d5-"));
    const fixtureFile = resolve(outDir, "fixture.js");
    const fs = await import("node:fs/promises");
    await fs.writeFile(fixtureFile, TINY_WASM_FIXTURE);
    try {
      const report = await runHarness(fixtureFile, {
        outDir,
        headless: true,
        postNavIdleMs: 1500,
        navTimeoutMs: 15_000,
      });

      // The wasm event should have fired.
      const wasmEvents = report.events.filter((e: any) => e.kind === "wasm");
      expect(wasmEvents.length).toBeGreaterThanOrEqual(1);
      const ev = wasmEvents[0] as any;
      expect(ev.op).toBe("compile");
      expect(ev.byteLength).toBe(14);
      expect(ev.sha256).toMatch(/^[a-f0-9]{64}$/);

      // The driver should have pushed a ScriptAnalysis with the WASM bytes.
      const wasmScript = report.scripts.find((s) => s.acquisition === "wasm");
      expect(wasmScript).toBeDefined();
      expect(wasmScript!.sha256).toBe(ev.sha256);
      expect(wasmScript!.bytes).toBe(14);
      expect(wasmScript!.savedTo).toMatch(/wasm\/[a-f0-9]{12}_wasm-compile\.wasm$/);
      // The empty static report has parse.ok=true (not a parse failure).
      expect(wasmScript!.staticReport.parse.ok).toBe(true);
      expect(wasmScript!.staticReport.findings).toHaveLength(0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("D10 CDP fallback for octet-stream bodies", () => {
  it.runIf(true)("captures a script served as application/octet-stream", async () => {
    if (!chromiumAvailable) return;
    const outDir = await mkdtemp(resolve(tmpdir(), "s2b-runtime-d10-"));

    // Tiny payload that contains a unique marker so we can assert
    // captureScript saw the right bytes.
    const SCRIPT_BODY = "/* D10-MARKER */\nwindow.__d10_loaded = navigator.userAgent.length;";
    let server: Server | null = null;
    let browser: any = null;
    try {
      server = await new Promise<Server>((resolveSrv) => {
        const s = createServer((req, res) => {
          if (req.url === "/payload.bin") {
            // Serve JS as application/octet-stream — the case
            // Playwright's requestfinished path normally gives up on.
            res.writeHead(200, { "content-type": "application/octet-stream" });
            res.end(SCRIPT_BODY);
            return;
          }
          // Minimal HTML page that loads the payload as a script.
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body><script src="/payload.bin"></script></body></html>`);
        });
        s.listen(0, "127.0.0.1", () => resolveSrv(s));
      });
      const port = (server.address() as { port: number }).port;

      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const session = await attach(context, { outDir });
      const page = await context.newPage();
      // The per-page CDP session is set up by a context.on("page", …)
      // handler that runs async; Playwright doesn't await it. Give it
      // a beat to finish enabling the Network domain before the goto
      // starts the request stream.
      await page.waitForTimeout(200);
      await page.goto(`http://127.0.0.1:${port}/`);
      // Give CDP's loadingFinished + getResponseBody a beat.
      await page.waitForTimeout(500);
      const report = await session.report({ flush: true });

      const captured = report.scripts.find((s) => s.name.includes("payload.bin"));
      expect(captured).toBeDefined();
      expect(captured!.acquisition).toBe("network");
      expect(captured!.bytes).toBe(SCRIPT_BODY.length);
      // The static analyzer ran on it (it's regular JS).
      expect(captured!.staticReport.parse.ok).toBe(true);

      await session.detach();
    } finally {
      if (browser) await browser.close();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// D3: module-worker bootstrap. The fixture spawns a worker with
// `{type: "module"}` whose body is an ES module hosted at a data:
// URL — same-origin restrictions don't apply to module workers
// loaded from data:.
const D3_MODULE_WORKER_FIXTURE = `
  (async () => {
    // The user worker is an ES module. Body: do nothing, just signal.
    const userBody = "self.postMessage('alive');";
    const userUrl = "data:application/javascript;base64," + btoa(userBody);
    const w = new Worker(userUrl, { type: "module" });
    // Don't wait on the worker — the trap captures the constructor
    // call synchronously, which is what we assert.
    void w;
  })().catch(() => { /* failures surface in the report */ });
`;

describe("D3 module-worker trap", () => {
  it.runIf(true)("emits a worker sink with method=module for module workers", async () => {
    if (!chromiumAvailable) return;
    const outDir = await mkdtemp(resolve(tmpdir(), "s2b-runtime-d3-"));
    const fixtureFile = resolve(outDir, "fixture.js");
    const fs = await import("node:fs/promises");
    await fs.writeFile(fixtureFile, D3_MODULE_WORKER_FIXTURE);
    try {
      const report = await runHarness(fixtureFile, {
        outDir,
        headless: true,
        postNavIdleMs: 1500,
        navTimeoutMs: 15_000,
      });
      // The worker sink fires synchronously inside `new Worker(...)`.
      const workerSinks = report.reconstructedSinks.filter((s) => s.kind === "worker");
      expect(workerSinks.length).toBeGreaterThanOrEqual(1);
      const moduleSink = workerSinks.find((s) => s.method === "module");
      expect(moduleSink).toBeDefined();
      // URL is the user's data: URL (the trap captures the original
      // URL before rewriting to the bootstrap blob).
      expect(moduleSink!.url).toMatch(/^data:application\/javascript;base64,/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// D14: spawn enough events to force the push binding to flush at
// least once. We set a tiny bufferByteCap and burn through navigator
// reads — each one pushes an access event through the trap. The
// driver-side state.pushedEvents is non-empty iff the binding fired.
const D14_PUSH_FIXTURE = `
  // ~100 navigator reads; the tiny byte cap forces rotation.
  for (let i = 0; i < 100; i++) {
    void navigator.userAgent;
    void navigator.platform;
    void navigator.language;
  }
`;

describe("D14 push-based buffer rotation", () => {
  it.runIf(true)("flushes events through exposeBinding instead of dropping", async () => {
    if (!chromiumAvailable) return;
    const outDir = await mkdtemp(resolve(tmpdir(), "s2b-runtime-d14-"));
    const fixtureFile = resolve(outDir, "fixture.js");
    const fs = await import("node:fs/promises");
    await fs.writeFile(fixtureFile, D14_PUSH_FIXTURE);
    try {
      const report = await runHarness(fixtureFile, {
        outDir,
        headless: true,
        postNavIdleMs: 1500,
        navTimeoutMs: 15_000,
        // Deliberately tiny: ~2 KB. Each access event is ~250 B,
        // so ~8 events fit before a flush is forced.
        bufferByteCap: 2 * 1024,
      });
      // Push mode is the lossless path; pull-mode drop-oldest is the
      // fallback. Both can be non-zero in a real run (the binding may
      // attach a tick after the first events fire), but pushedEvents
      // > 0 is the proof the binding path took.
      expect(report.summary.pushFlushes).toBeGreaterThanOrEqual(1);
      expect(report.summary.pushedEvents).toBeGreaterThanOrEqual(1);
      // Every pushed event must have made it into report.events with
      // the same seq accounting — sanity-check no duplicates.
      const seqs = report.events.map((e) => e.seq);
      const unique = new Set(seqs);
      expect(unique.size).toBe(seqs.length);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("D8 SubtleCrypto trap", () => {
  it.runIf(true)("captures digest + sign in a secure context", async () => {
    if (!chromiumAvailable) return;
    const outDir = await mkdtemp(resolve(tmpdir(), "s2b-runtime-d8-"));
    const fixtureFile = resolve(outDir, "fixture.js");
    const fs = await import("node:fs/promises");
    await fs.writeFile(fixtureFile, CRYPTO_FIXTURE);
    try {
      // http-harness mode → real http://127.0.0.1 origin → secure
      // context → crypto.subtle is available.
      const report = await runHarness(fixtureFile, {
        outDir,
        headless: true,
        harnessMode: "http-harness",
        postNavIdleMs: 1500,
        navTimeoutMs: 15_000,
      });

      const cryptoEvents = report.events.filter((e: any) => e.kind === "crypto");
      const digest = cryptoEvents.find((e: any) => e.op === "digest");
      expect(digest).toBeDefined();
      expect((digest as any).algorithm).toBe("SHA-256");
      expect((digest as any).inputByteLength).toBeGreaterThan(0);
      expect((digest as any).inputHexPreview).toMatch(/^[a-f0-9]+$/);

      const sign = cryptoEvents.find((e: any) => e.op === "sign");
      expect(sign).toBeDefined();
      expect((sign as any).algorithm).toBe("HMAC");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
