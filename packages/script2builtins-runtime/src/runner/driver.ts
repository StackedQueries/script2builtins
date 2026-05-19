/**
 * The Playwright-side driver.
 *
 * Exposes two entry points:
 *
 *   - {@link attach}: bind instrumentation to an existing
 *     `BrowserContext`. Returns a {@link Session} handle with
 *     `report({since,flush})` / `detach()`. This is the core primitive.
 *   - {@link run}: launch Chromium, navigate to a URL, attach, drain
 *     a final report, shut down. Convenience wrapper.
 */
import type { BrowserContext, Page, Request, Response } from "playwright";
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyze, ALL_APIS } from "script2builtins";
import { matchAccesses } from "script2builtins/analyze";
import type {
  AttachOptions,
  RunOptions,
  Session,
  RuntimeReport,
  AnyRuntimeEvent,
  ScriptAnalysis,
  AnnotatedFinding,
  Report as StaticReport,
} from "../types.js";
import { REPORT_VERSION } from "../types.js";
import { buildTrapScript, type BuiltTrapScript } from "../trap/build.js";
import { buildStealthScript, type BuiltStealthScript } from "./stealth.js";
import { renderHtmlIndex } from "../report/html.js";
import { renderRuntimeText } from "../report/text.js";
import { drainContext, attributeEvents, filterReflectNoise, parseStack, toRawAccesses, toNetworkSinks, toDynamicHazards } from "./collect.js";
import { mergeFindings, runtimeOnlyKeys, staticOnlyKeys } from "./merge.js";
import { catalogVersion } from "../catalog-version.js";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface InternalSessionState {
  trap: BuiltTrapScript;
  stealth: BuiltStealthScript | null;
  outDir: string;
  options: AttachOptions;
  /** SHA-256 of every captured script body, keyed by URL. */
  urlToSha: Map<string, string>;
  /** Captured script entries — populated as `requestfinished` fires. */
  scripts: Map<string, RawScriptEntry>;
  /** Inline scripts we extracted from the DOM. */
  inlineSeen: Set<string>;
  /** Events drained but not yet projected — kept so consumers see only `since` deltas. */
  drained: AnyRuntimeEvent[];
  /** Highest seq observed. */
  cursor: number;
  /** Pages already open at attach time (not instrumented). */
  preExistingPages: number;
  /** Total buffer overflow count reported by the in-page channel. */
  bufferOverflows: number;
  /** Per-kind buffer overflow counts. */
  bufferOverflowsByKind: { access: number; sink: number; hazard: number };
  /**
   * D14: events pushed proactively from the in-page trap when its
   * buffer was about to overflow. Kept separate from `drained` so
   * the cursor accounting in {@link buildReport} can dedupe by `seq`
   * — Playwright bindings deliver out-of-band from the regular
   * `page.evaluate` drain path.
   */
  pushedEventQueue: AnyRuntimeEvent[];
  /** D14: count of push-binding callbacks fired (one per flush, not per event). */
  pushFlushes: number;
  /** D14: cumulative events delivered via the binding across the whole session. */
  pushedEventCount: number;
  /** ISO timestamp captured at attach time. */
  startedAt: string;
  /** Listener disposers. */
  disposers: Array<() => void>;
  /** Set true once detach has run. */
  detached: boolean;
  /** Cache of `analyze()` results keyed by sha. */
  staticReportCache: Map<string, StaticReport>;
}

interface RawScriptEntry {
  url: string;
  sha256: string;
  bytes: number;
  source: string;
  acquisition: ScriptAnalysis["acquisition"];
  frames: Set<string>;
  savedTo: string | null;
}

/**
 * Bind instrumentation to an existing context. Call this BEFORE opening
 * pages in the context so they boot with traps installed. Pages already
 * open are not instrumented (and counted in `summary.preExistingPages`).
 */
export async function attach(context: BrowserContext, options: AttachOptions): Promise<Session> {
  const trap = buildTrapScript({
    stackLimit: options.stackLimit,
    bodyPreviewLimit: options.bodyPreviewLimit,
    bufferByteCap: options.bufferByteCap,
    evalSourceCap: options.evalSourceCap,
    evalRecursionDepth: options.evalRecursionDepth,
    useProxyRoots: options.useProxyRoots,
    trapDynamicExec: options.trapDynamicExec,
    hardenIntrospection: options.hardenIntrospection,
    trapReflectGet: options.trapReflectGet,
    trapWorkers: options.trapWorkers,
    workerTrapGlobalName: options.workerTrapGlobalName,
    verbose: options.verbose,
    categories: options.trapCategories,
    channelName: options.channelName,
  });

  // Optional stealth shim. Built BEFORE the trap so it lands as the
  // first init script — patches navigator surfaces that headless
  // Chromium gets wrong, ahead of the trap installing its Proxy. See
  // docs/stealth-mode.md for the matrix of what this covers.
  let stealth: BuiltStealthScript | null = null;
  if (options.stealth) {
    stealth = buildStealthScript(
      typeof options.stealth === "object" ? options.stealth : {},
    );
    await context.addInitScript({ content: stealth.source });
  }

  await mkdir(resolve(options.outDir, "scripts"), { recursive: true });
  await mkdir(resolve(options.outDir, "request-bodies"), { recursive: true });
  await mkdir(resolve(options.outDir, "evals"), { recursive: true });
  await mkdir(resolve(options.outDir, "wasm"), { recursive: true });

  // If worker instrumentation is on, pre-publish the trap source on
  // globalThis under a known name BEFORE the main trap runs. The main
  // trap reads this in its Worker constructor wrap to create a blob URL
  // that classic workers can importScripts. The global name is
  // randomized per build (trap.config.workerTrapGlobalName) and
  // surfaced on Session.workerTrapGlobalName so stealth shims can
  // avoid it.
  if (trap.config.trapWorkers) {
    const workerSrcLiteral = JSON.stringify(trap.source);
    const nameLiteral = JSON.stringify(trap.config.workerTrapGlobalName);
    await context.addInitScript({
      content: `;(function(){try{globalThis[${nameLiteral}]=${workerSrcLiteral};}catch(e){}})();`,
    });
  }

  // D14: expose a push binding so the trap can flush events to Node
  // before the in-page byte cap forces drop-oldest. Must run BEFORE
  // the trap init script — the trap closes over the name at install
  // time and resolves it lazily on each push, but exposing the binding
  // late opens a small window where push() sees a missing function and
  // falls back to drop-oldest. Exposing first is harmless: the trap
  // simply notices the function and starts using it.
  const pushBindingName = `${trap.config.channelName}_push`;
  try {
    await context.exposeBinding(pushBindingName, (_source, batch: unknown) => {
      if (!Array.isArray(batch)) return;
      // Defensive copy — Playwright already structured-clones each
      // arg, but the trap may also be using these objects locally
      // after the call returns.
      for (const ev of batch) {
        if (ev && typeof ev === "object") {
          state.pushedEventQueue.push(ev as AnyRuntimeEvent);
          state.pushedEventCount++;
        }
      }
      state.pushFlushes++;
    });
  } catch {
    // exposeBinding throws if the name is already bound on the context
    // (rare — the random channel name should prevent collisions). The
    // trap quietly falls back to drop-oldest if the binding isn't
    // there, so this is non-fatal.
  }

  await context.addInitScript({ content: trap.source });

  // Shared map for D10: requestId → response metadata for opaque /
  // octet-stream bodies that Playwright's `requestfinished` path
  // refuses. CDP reaches into the raw network stack and can fetch
  // these via `Network.getResponseBody`.
  const cdpPendingBodies = new Map<string, { url: string; frame: string | null; cdp: any }>();

  // CDP: swallow `debugger` statements that detectors use to detect
  // DevTools attach, and (D10) subscribe to Network events so we can
  // recover script bodies for content-types Playwright's high-level
  // API doesn't expose (notably application/octet-stream SDK
  // telemetry payloads).
  context.on("page", async (page) => {
    let cdp: any;
    try {
      cdp = await context.newCDPSession(page);
      await cdp.send("Debugger.enable");
      await cdp.send("Debugger.setSkipAllPauses", { skip: true });
    } catch {
      // CDP may be unavailable in some environments (Firefox, WebKit).
      return;
    }
    try {
      await cdp.send("Network.enable");
    } catch {
      return;
    }
    cdp.on("Network.responseReceived", (params: any) => {
      try {
        const resp = params && params.response;
        if (!resp) return;
        const headers: Record<string, string> = resp.headers || {};
        // Case-insensitive content-type lookup.
        let ct = "";
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === "content-type") { ct = String(headers[k]).toLowerCase(); break; }
        }
        // Only target the cases the requestfinished path misses today.
        // `application/octet-stream` is the canonical telemetry-blob
        // content type; some sites also serve detector JS as
        // `application/x-binary` or similar.
        if (!ct.includes("octet-stream") && !ct.includes("x-binary")) return;
        cdpPendingBodies.set(params.requestId, {
          url: resp.url,
          frame: params.frameId ?? null,
          cdp,
        });
      } catch { /* never break delivery */ }
    });
    cdp.on("Network.loadingFinished", async (params: any) => {
      const meta = cdpPendingBodies.get(params.requestId);
      if (!meta) return;
      cdpPendingBodies.delete(params.requestId);
      if (state.detached) return;
      try {
        const result = await meta.cdp.send("Network.getResponseBody", { requestId: params.requestId });
        if (!result) return;
        const raw: string = result.body ?? "";
        if (!raw) return;
        const source = result.base64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
        if (source.length === 0 || source.length > 8 * 1024 * 1024) return;
        await captureScript(state, {
          url: meta.url,
          source,
          acquisition: "network",
          frame: meta.frame,
        });
      } catch {
        // Body may have been evicted from CDP's buffer or the request
        // was cancelled. Best-effort.
      }
    });
    cdp.on("Network.loadingFailed", (params: any) => {
      cdpPendingBodies.delete(params.requestId);
    });
  });

  const state: InternalSessionState = {
    trap,
    stealth,
    outDir: options.outDir,
    options,
    urlToSha: new Map(),
    scripts: new Map(),
    inlineSeen: new Set(),
    drained: [],
    cursor: -1,
    preExistingPages: context.pages().length,
    bufferOverflows: 0,
    bufferOverflowsByKind: { access: 0, sink: 0, hazard: 0 },
    pushedEventQueue: [],
    pushFlushes: 0,
    pushedEventCount: 0,
    startedAt: new Date().toISOString(),
    disposers: [],
    detached: false,
    staticReportCache: new Map(),
  };

  const reqFinishedHandler = async (request: Request) => {
    if (state.detached) return;
    let response: Response | null = null;
    try {
      response = await request.response();
    } catch {
      return;
    }
    if (!response) return;
    const url = request.url();
    const headers = (await response.allHeaders().catch(() => ({}))) as Record<string, string>;
    const ct = (headers["content-type"] ?? "").toLowerCase();
    const looksJs =
      ct.includes("javascript") ||
      ct.includes("ecmascript") ||
      url.endsWith(".js") ||
      url.endsWith(".mjs");
    if (!looksJs) return;
    let body: Buffer;
    try {
      body = await response.body();
    } catch {
      return;
    }
    if (body.length === 0 || body.length > 8 * 1024 * 1024) return;
    const source = body.toString("utf8");
    await captureScript(state, {
      url,
      source,
      acquisition: "network",
      frame: request.frame()?.url() ?? null,
    });
  };

  context.on("requestfinished", reqFinishedHandler);
  state.disposers.push(() => context.off("requestfinished", reqFinishedHandler));

  // Trap inside Web Workers spawned by any page. Each worker gets the
  // same trap script via the worker-side `context.on('worker')` event.
  const workerHandler = async (worker: any) => {
    try {
      // Capture the worker source for static analysis.
      const wurl = worker.url();
      // We still capture the worker URL as a network-script later when
      // it's fetched. Workers don't expose source via Playwright, so
      // rely on the network request that fetched the worker bundle.
      void wurl;
    } catch {}
  };
  (context as any).on("worker", workerHandler);
  state.disposers.push(() => (context as any).off("worker", workerHandler));

  // Forward in-page console.debug when verbose.
  if (options.verbose) {
    const consoleHandler = (msg: any) => {
      if (msg.type() === "debug") process.stderr.write(`[s2bRt] ${msg.text()}\n`);
    };
    context.on("console", consoleHandler);
    state.disposers.push(() => context.off("console", consoleHandler));
  }

  const session: Session & { _state: InternalSessionState } = {
    trapScriptSha256: trap.sha256,
    channelName: trap.config.channelName,
    workerTrapGlobalName: trap.config.workerTrapGlobalName,
    stealthScriptSha256: stealth ? stealth.sha256 : null,
    get cursor() {
      return state.cursor;
    },
    async report(opts) {
      return buildReport(context, state, opts ?? {});
    },
    async detach() {
      if (state.detached) return;
      state.detached = true;
      for (const d of state.disposers) {
        try {
          d();
        } catch {}
      }
    },
    _state: state,
  };
  return session;
}

/**
 * Launch Chromium, attach, navigate, drain, shut down. Use this when
 * you just want a turn-key URL → report pipeline.
 */
export async function run(options: RunOptions): Promise<RuntimeReport> {
  const browser = await chromium.launch({ headless: options.headless ?? false });
  try {
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1366, height: 800 },
      userAgent: options.userAgent ?? DEFAULT_UA,
      bypassCSP: true,
      extraHTTPHeaders: options.extraHeaders,
    });
    if (options.cookies && options.cookies.length > 0) {
      await context.addCookies(
        options.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path ?? "/",
        })),
      );
    }
    const session = await attach(context, options);
    const page = await context.newPage();

    let navError: string | null = null;
    try {
      await page.goto(options.url, {
        waitUntil: "domcontentloaded",
        timeout: options.navTimeoutMs ?? 30_000,
      });
    } catch (err) {
      navError = err instanceof Error ? err.message : String(err);
    }
    await page.waitForTimeout(options.postNavIdleMs ?? 10_000);

    // Extract inline scripts before draining so they're attributable.
    await extractInlineScripts(page, (session as any)._state);

    // Save the rendered HTML.
    try {
      const html = await page.content();
      await writeFile(resolve(options.outDir, "page.html"), html);
    } catch {}

    const report = await session.report({ flush: true });
    report.target = options.url;
    report.navError = navError;
    report.harnessMode = options.harnessMode ?? (options.url.startsWith("data:") ? "data" : "url");
    await session.detach();
    await context.close();
    return report;
  } finally {
    await browser.close();
  }
}

/** Persist a captured script + remember its hash. */
async function captureScript(
  state: InternalSessionState,
  spec: {
    url: string;
    source: string;
    acquisition: ScriptAnalysis["acquisition"];
    frame: string | null;
  },
): Promise<RawScriptEntry> {
  const sha256 = createHash("sha256").update(spec.source).digest("hex");
  const existing = state.scripts.get(sha256);
  if (existing) {
    if (spec.frame) existing.frames.add(spec.frame);
    state.urlToSha.set(spec.url, sha256);
    return existing;
  }
  const safe = sanitize(spec.url);
  const dir =
    spec.acquisition === "eval" || spec.acquisition === "function-ctor" || spec.acquisition === "settimeout-string"
      ? "evals"
      : "scripts";
  const savedTo = resolve(state.outDir, dir, `${sha256.slice(0, 12)}_${safe}.js`);
  await writeFile(savedTo, spec.source);
  const entry: RawScriptEntry = {
    url: spec.url,
    sha256,
    bytes: Buffer.byteLength(spec.source, "utf8"),
    source: spec.source,
    acquisition: spec.acquisition,
    frames: new Set(spec.frame ? [spec.frame] : []),
    savedTo,
  };
  state.scripts.set(sha256, entry);
  state.urlToSha.set(spec.url, sha256);
  return entry;
}

/**
 * Build an empty static-analysis report for entries that can't be
 * parsed (WASM modules, malformed JS that throws inside analyze). Used
 * by the static pass to keep the per-script bundle shape consistent.
 */
function emptyStaticReport(name: string, bytes: number, errorOrSentinel: string): StaticReport {
  const isWasm = errorOrSentinel === "wasm";
  return {
    source: { name, bytes, lines: 0 },
    parse: { ok: isWasm, sourceType: "script", errors: isWasm ? [] : [errorOrSentinel] },
    findings: [],
    byCategory: {},
    hazards: [],
    networkSinks: [],
    structural: [],
    unknownAccesses: [],
    summary: {
      totalAccesses: 0,
      knownAccesses: 0,
      botDetectionTells: 0,
      fingerprintingDensityPerKb: 0,
      categories: [],
      sinkCount: 0,
      leakedApiCount: 0,
      providers: {},
      vmBytecodeDetected: false,
      antiDebugTells: 0,
      consistencyChecks: 0,
    },
  };
}

/** D5: persist a captured WASM module as a script with acquisition="wasm". */
async function captureWasm(
  state: InternalSessionState,
  spec: {
    bytes: Buffer;
    sha256: string;
    op: "compile" | "compileStreaming" | "instantiate" | "instantiateStreaming";
    frame: string | null;
  },
): Promise<RawScriptEntry> {
  const existing = state.scripts.get(spec.sha256);
  if (existing) {
    if (spec.frame) existing.frames.add(spec.frame);
    return existing;
  }
  const safe = `wasm-${spec.op}`;
  const savedTo = resolve(state.outDir, "wasm", `${spec.sha256.slice(0, 12)}_${safe}.wasm`);
  await writeFile(savedTo, spec.bytes);
  // Synthetic URL keeps the entry distinguishable in reports without
  // colliding with any real network URL.
  const url = `wasm:${spec.op}/${spec.sha256.slice(0, 12)}`;
  const entry: RawScriptEntry = {
    url,
    sha256: spec.sha256,
    bytes: spec.bytes.length,
    // `source` is the JS-side representation. For WASM there isn't one;
    // we keep it empty so the static analyzer skip below treats this
    // entry as "no JS to analyse".
    source: "",
    acquisition: "wasm",
    frames: new Set(spec.frame ? [spec.frame] : []),
    savedTo,
  };
  state.scripts.set(spec.sha256, entry);
  return entry;
}

async function extractInlineScripts(page: Page, state: InternalSessionState): Promise<void> {
  for (const frame of page.frames()) {
    // Pull (a) `<script>` content without a src, (b) `<script src="data:…">`
    // whose body Playwright's `requestfinished` doesn't surface, and
    // (c) `<iframe srcdoc=…>` attribute values. Srcdoc iframes parse
    // their own scripts (which we'd then catch by walking the child
    // frame), but capturing the raw srcdoc attribute is defensive: it
    // surfaces scripts even if the iframe was removed pre-parse, never
    // navigated, or hit a cross-origin guard.
    let dump: {
      inlines: string[];
      dataUrls: Array<{ url: string; source: string }>;
      srcdocs: string[];
    } = { inlines: [], dataUrls: [], srcdocs: [] };
    try {
      dump = await frame.evaluate(() => {
        const inlines = Array.from(document.querySelectorAll("script:not([src])"))
          .map((s) => s.textContent ?? "")
          .filter((s) => s.length > 0);
        const dataUrls: Array<{ url: string; source: string }> = [];
        for (const el of Array.from(document.querySelectorAll('script[src^="data:"]'))) {
          const src = (el as HTMLScriptElement).getAttribute("src") ?? "";
          if (!src) continue;
          // data:<mime>[;base64],<payload>
          const m = /^data:([^,;]*)(;base64)?,(.*)$/s.exec(src);
          if (!m) continue;
          const payload = m[3] ?? "";
          let source: string;
          try {
            source = m[2] === ";base64" ? atob(payload) : decodeURIComponent(payload);
          } catch {
            continue;
          }
          if (source.length > 0) dataUrls.push({ url: src, source });
        }
        const srcdocs = Array.from(document.querySelectorAll("iframe[srcdoc]"))
          .map((el) => (el as HTMLIFrameElement).getAttribute("srcdoc") ?? "")
          .filter((s) => s.length > 0);
        return { inlines, dataUrls, srcdocs };
      });
    } catch {
      continue;
    }
    for (const source of dump.inlines) {
      await persistInline(state, frame.url(), source, "inline");
    }
    for (const { url, source } of dump.dataUrls) {
      // Use the raw data: URL as the canonical key so stack-trace
      // attribution can hash-match it via state.urlToSha. Acquisition
      // is "inline" because it isn't a real network fetch.
      const sha = createHash("sha256").update(source).digest("hex");
      if (state.inlineSeen.has(sha)) continue;
      state.inlineSeen.add(sha);
      await captureScript(state, {
        url,
        source,
        acquisition: "inline",
        frame: frame.url(),
      });
    }
    for (const srcdoc of dump.srcdocs) {
      // Pull `<script>…</script>` bodies out of the srcdoc HTML. We do
      // this on the Node side so the analyzer always sees pure JS (the
      // srcdoc itself is an HTML fragment, not feedable to a JS
      // parser).
      for (const body of extractScriptBodies(srcdoc)) {
        if (!body.trim()) continue;
        await persistInline(state, frame.url(), body, "srcdoc");
      }
      // If the srcdoc had no inline scripts (only `<script src=…>`),
      // the captureScript flow already covers the fetch. Nothing else
      // to do.
    }
  }
}

async function persistInline(
  state: InternalSessionState,
  frameUrl: string,
  source: string,
  acquisition: "inline" | "srcdoc",
): Promise<void> {
  if (!source.trim()) return;
  const sha = createHash("sha256").update(source).digest("hex");
  if (state.inlineSeen.has(sha)) return;
  state.inlineSeen.add(sha);
  const url = `${frameUrl}#${acquisition}-${sha.slice(0, 8)}`;
  await captureScript(state, {
    url,
    source,
    acquisition,
    frame: frameUrl,
  });
}

/**
 * Extract `<script>…</script>` bodies from an HTML fragment. Skips
 * `<script src=…>` (those are network requests we already capture)
 * and `<script type="application/json">` style data blobs.
 *
 * Exported for unit testing.
 */
export function extractScriptBodies(html: string): string[] {
  const out: string[] = [];
  // The HTML parser is a fairly faithful regex here; for forensic
  // purposes we don't need full spec correctness. We require a
  // closing `</script>` and exclude tags with a `src` attribute.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    // Skip JSON/JSON-LD data blocks — they aren't JS.
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    if (typeMatch && typeMatch[1] && !/javascript|module|application\/javascript/i.test(typeMatch[1])) {
      continue;
    }
    out.push(m[2] ?? "");
  }
  return out;
}

async function buildReport(
  context: BrowserContext,
  state: InternalSessionState,
  opts: { since?: number; flush?: boolean },
): Promise<RuntimeReport> {
  const channelName = state.trap.config.channelName;
  const since = opts.since ?? -1;

  // D14: ask the trap to flush any residual buffered events through
  // the binding before we drain. This makes the push path the
  // authoritative source even at quiet shutdown — anything still in
  // the in-page buffer would otherwise come through the channel.
  // Done before drainContext so the channel drain we do next finds an
  // empty buffer when push mode is active.
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    try {
      await page.evaluate((name) => {
        const ch = (globalThis as any)[name];
        if (ch && typeof ch.flushToBinding === "function") ch.flushToBinding();
      }, channelName);
    } catch { /* page navigating away, etc. — non-fatal */ }
  }

  const pullDrain = await drainContext(context, channelName, since);

  // Merge pull-drained events with events the trap pushed
  // asynchronously through the exposeBinding channel. Both carry
  // monotonic `seq`s assigned in-page, so dedupe by seq keeps a single
  // copy if (rarely) the same event appears in both lanes.
  const seen = new Set<number>();
  const fresh: AnyRuntimeEvent[] = [];
  for (const ev of pullDrain) {
    if (typeof ev.seq !== "number" || ev.seq <= since) continue;
    if (seen.has(ev.seq)) continue;
    seen.add(ev.seq);
    fresh.push(ev);
  }
  // Drain the push buffer once per report so a long-running session
  // doesn't reprocess them on each call. We re-include them on flush
  // through `state.drained` like every other event.
  const pushed = state.pushedEventQueue;
  state.pushedEventQueue = [];
  for (const ev of pushed) {
    if (typeof ev.seq !== "number" || ev.seq <= since) continue;
    if (seen.has(ev.seq)) continue;
    seen.add(ev.seq);
    fresh.push(ev);
  }
  // Restore monotonic seq ordering across the two sources.
  fresh.sort((a, b) => a.seq - b.seq);
  for (const ev of fresh) {
    const parsed = parseStack(ev.stack);
    ev.scriptUrl = parsed.url;
    ev.line = parsed.line;
    ev.column = parsed.column;
    if (ev.seq > state.cursor) state.cursor = ev.seq;
  }
  attributeEvents(fresh, state.urlToSha);

  // D2: drop reflect-via accesses whose top frame is from a vendored
  // /node_modules/ library bundle — they're rarely fingerprinting code.
  filterReflectNoise(fresh);

  // Capture eval/Function/setTimeout-string source as synthetic scripts.
  for (const ev of fresh) {
    if (ev.kind !== "hazard") continue;
    if (ev.hazardKind !== "eval" && ev.hazardKind !== "Function" && ev.hazardKind !== "setTimeout-string") continue;
    if (!ev.source) continue;
    const sha = createHash("sha256").update(ev.source).digest("hex");
    ev.sha256 = sha;
    if (state.scripts.has(sha)) continue;
    const host = ev.scriptUrl ? safeHost(ev.scriptUrl) : "unknown";
    const acq: ScriptAnalysis["acquisition"] =
      ev.hazardKind === "eval"
        ? "eval"
        : ev.hazardKind === "Function"
          ? "function-ctor"
          : "settimeout-string";
    await captureScript(state, {
      url: `eval-from-${host}-${sha.slice(0, 8)}.js`,
      source: ev.source,
      acquisition: acq,
      frame: ev.scriptUrl,
    });
  }

  // D5: capture WebAssembly modules as scripts with acquisition="wasm".
  for (const ev of fresh) {
    if (ev.kind !== "wasm") continue;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(ev.bytesBase64, "base64");
    } catch {
      continue;
    }
    if (bytes.length === 0) continue;
    const sha = createHash("sha256").update(bytes).digest("hex");
    ev.sha256 = sha;
    if (state.scripts.has(sha)) continue;
    await captureWasm(state, {
      bytes,
      sha256: sha,
      op: ev.op,
      frame: ev.scriptUrl,
    });
  }

  // Pull buffer-overflow counters from one of the pages (idempotent).
  // The trap-side counter is monotonic so we keep the max we've seen.
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    try {
      const stats = await page.evaluate((name) => {
        const ch = (globalThis as any)[name];
        if (!ch) return null;
        return {
          total: ch.bufferOverflows,
          byKind: ch.bufferOverflowsByKind,
        };
      }, channelName);
      if (stats) {
        state.bufferOverflows = Math.max(state.bufferOverflows, stats.total ?? 0);
        const bk = stats.byKind ?? {};
        state.bufferOverflowsByKind.access = Math.max(state.bufferOverflowsByKind.access, bk.access ?? 0);
        state.bufferOverflowsByKind.sink = Math.max(state.bufferOverflowsByKind.sink, bk.sink ?? 0);
        state.bufferOverflowsByKind.hazard = Math.max(state.bufferOverflowsByKind.hazard, bk.hazard ?? 0);
      }
    } catch {}
  }

  // Accumulate (when not flushing, we still need prior drains for the report).
  if (!opts.flush) state.drained.push(...fresh);
  const allEvents = opts.flush ? state.drained.concat(fresh) : state.drained.slice();
  if (opts.flush) state.drained = [];

  // Reconstruct + match runtime.
  const rawRuntime = toRawAccesses(allEvents);
  const sinks = toNetworkSinks(allEvents);
  const hazards = toDynamicHazards(allEvents);
  const { findings: runtimeFindings } = matchAccesses(rawRuntime, ALL_APIS);

  // Static pass: analyze every captured script + bundle.
  const scriptBundles: ScriptAnalysis[] = [];
  const allStaticFindings: typeof runtimeFindings = [];
  for (const entry of state.scripts.values()) {
    let staticReport = state.staticReportCache.get(entry.sha256);
    if (!staticReport) {
      // D5: WASM entries have no JS source. Skip the parser and produce
      // an empty report with parse.ok=true so analysts don't see a
      // bogus parse-failure entry.
      if (entry.acquisition === "wasm") {
        staticReport = emptyStaticReport(entry.url, entry.bytes, "wasm");
      } else {
        try {
          staticReport = analyze(entry.source, { name: entry.url });
        } catch (err) {
          staticReport = emptyStaticReport(entry.url, entry.bytes, String(err));
        }
      }
      state.staticReportCache.set(entry.sha256, staticReport);
    }
    for (const f of staticReport.findings) allStaticFindings.push(f);

    // Per-script event range
    const eventsForScript = allEvents.filter((ev) => ev.scriptSha256 === entry.sha256);
    const startSeq = eventsForScript[0]?.seq ?? null;
    const endSeq = eventsForScript[eventsForScript.length - 1]?.seq ?? null;

    // trapCoverage = fraction of static findings whose key fired at runtime
    const runtimeKeys = new Set<string>();
    for (const ev of eventsForScript) {
      if (ev.kind === "access") {
        runtimeKeys.add(ev.chain.join("."));
      }
    }
    const staticKeys = new Set(staticReport.findings.map((f) => f.api.key));
    let covered = 0;
    for (const key of staticKeys) {
      if (runtimeKeys.has(key)) covered++;
    }
    const trapCoverage = staticKeys.size > 0 ? covered / staticKeys.size : 0;

    scriptBundles.push({
      name: entry.url,
      sha256: entry.sha256,
      bytes: entry.bytes,
      acquisition: entry.acquisition,
      frames: [...entry.frames],
      staticReport,
      eventRange: [startSeq, endSeq],
      trapCoverage,
      savedTo: entry.savedTo,
    });
  }

  // Merge static + runtime.
  const merged = mergeFindings({
    staticFindings: allStaticFindings,
    runtimeFindings,
    runtimeEvents: allEvents,
  });

  const byCategory: Record<string, AnnotatedFinding[]> = {};
  for (const f of merged) {
    (byCategory[f.api.category] ??= []).push(f);
  }

  const runtimeCategories = new Set<string>();
  for (const f of merged) {
    if (f.provenance === "runtime" || f.provenance === "static+runtime") {
      runtimeCategories.add(f.api.category);
    }
  }

  const knownAccesses = merged.reduce((n, f) => n + f.count, 0);
  const botDetectionTells = merged.filter((f) => f.api.botDetectionTell).length;
  const leakedApiSet = new Set<string>();
  for (const s of sinks) {
    for (const e of s.payload?.leakedApis ?? []) leakedApiSet.add(e.key);
  }

  const acquisitionCount = (kind: string) =>
    scriptBundles.filter((s) => s.acquisition === kind).length;

  const report: RuntimeReport = {
    reportVersion: REPORT_VERSION,
    catalogVersion: catalogVersion(),
    trapScriptSha256: state.trap.sha256,
    stealthScriptSha256: state.stealth ? state.stealth.sha256 : null,
    target: "",
    runId: state.startedAt.replace(/[:.]/g, "-"),
    startedAt: state.startedAt,
    endedAt: new Date().toISOString(),
    navError: null,
    harnessMode: "url",
    events: allEvents,
    scripts: scriptBundles,
    reconstructedAccesses: rawRuntime,
    reconstructedSinks: sinks,
    hazards,
    findings: merged,
    byCategory,
    summary: {
      totalScripts: scriptBundles.length,
      networkScripts: acquisitionCount("network"),
      inlineScripts: acquisitionCount("inline"),
      srcdocScripts: acquisitionCount("srcdoc"),
      evalScripts: acquisitionCount("eval") + acquisitionCount("function-ctor") + acquisitionCount("settimeout-string"),
      totalAccesses: rawRuntime.length + allStaticFindings.reduce((n, f) => n + f.count, 0),
      runtimeAccesses: rawRuntime.length,
      staticAccesses: allStaticFindings.reduce((n, f) => n + f.count, 0),
      knownAccesses,
      botDetectionTells,
      sinkCount: sinks.length,
      leakedApiCount: leakedApiSet.size,
      runtimeCategories: [...runtimeCategories].sort(),
      runtimeOnlyKeys: runtimeOnlyKeys(merged),
      staticOnlyKeys: staticOnlyKeys(merged),
      preExistingPages: state.preExistingPages,
      bufferOverflows: state.bufferOverflows,
      bufferOverflowsByKind: { ...state.bufferOverflowsByKind },
      pushFlushes: state.pushFlushes,
      pushedEvents: state.pushedEventCount,
    },
  };

  if (opts.flush) {
    await persistReport(state.outDir, report);
  }
  return report;
}

async function persistReport(outDir: string, report: RuntimeReport): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(
    resolve(outDir, "manifest.json"),
    JSON.stringify(
      {
        target: report.target,
        runId: report.runId,
        startedAt: report.startedAt,
        endedAt: report.endedAt,
        reportVersion: report.reportVersion,
        catalogVersion: report.catalogVersion,
        trapScriptSha256: report.trapScriptSha256,
        stealthScriptSha256: report.stealthScriptSha256,
        harnessMode: report.harnessMode,
        navError: report.navError,
        scripts: report.scripts.map((s) => ({
          name: s.name,
          sha256: s.sha256,
          bytes: s.bytes,
          acquisition: s.acquisition,
          frames: s.frames,
          eventRange: s.eventRange,
          trapCoverage: s.trapCoverage,
          savedTo: s.savedTo,
        })),
        summary: report.summary,
      },
      null,
      2,
    ),
  );
  // D12: human-readable `report.txt` + linkable `index.html` so a
  // run directory is shareable from a ticket / paste without
  // anyone needing the CLI installed.
  try {
    const text = renderRuntimeText(report, { noColor: true });
    await writeFile(resolve(outDir, "report.txt"), text);
  } catch {
    // Renderer is best-effort; the JSON is the authoritative artifact.
  }
  try {
    const html = renderHtmlIndex(report, {
      jsonReportHref: "./report.json",
      textReportHref: "./report.txt",
    });
    await writeFile(resolve(outDir, "index.html"), html);
  } catch {
    // Same.
  }
  // Per-script reports.
  for (const s of report.scripts) {
    if (!s.savedTo) continue;
    try {
      await writeFile(`${s.savedTo}.report.json`, JSON.stringify(s.staticReport, null, 2));
    } catch {}
  }
}

function sanitize(s: string): string {
  return s.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || "unknown";
  } catch {
    return "unknown";
  }
}

/** Compatibility shim — the unified CLI used `runFromUrl` in earlier drafts. */
export async function runFromUrl(
  url: string,
  outDir: string,
  extra: Partial<RunOptions> = {},
): Promise<RuntimeReport> {
  return run({ url, outDir, ...extra });
}

