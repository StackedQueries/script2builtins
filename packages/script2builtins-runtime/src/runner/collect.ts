/**
 * Event collection + reconstruction.
 *
 * Pulls raw events from the in-page channel via {@link page.evaluate},
 * back-fills `scriptSha256` from a url→hash map, and reconstructs the
 * static analyzer's input types ({@link RawAccess}, {@link NetworkSink},
 * {@link DynamicHazard}) so the same matcher can consume them.
 */
import type { Page, BrowserContext } from "playwright";
import type {
  AnyRuntimeEvent,
  RuntimeAccessEvent,
  RuntimeSinkEvent,
  RuntimeHazardEvent,
} from "../types.js";
import type {
  ApiDefinition,
  RawAccess,
  NetworkSink,
  DynamicHazard,
  Location,
} from "script2builtins/types";
import { parseRuntimeBody } from "script2builtins/analyze";
import { ALL_APIS } from "script2builtins";

/** Pull a batch of events from one page's channel. */
export async function drainPage(
  page: Page,
  channelName: string,
  since: number,
): Promise<AnyRuntimeEvent[]> {
  if (page.isClosed()) return [];
  try {
    return await page.evaluate(
      ({ name, s }) => {
        const ch = (globalThis as any)[name];
        if (!ch || typeof ch.drain !== "function") return [];
        return ch.drain(s);
      },
      { name: channelName, s: since },
    );
  } catch {
    // Page navigated away mid-drain, frame detached, etc. Not fatal.
    return [];
  }
}

/** Pull events from every open page in the context. */
export async function drainContext(
  context: BrowserContext,
  channelName: string,
  since: number,
): Promise<AnyRuntimeEvent[]> {
  const out: AnyRuntimeEvent[] = [];
  await Promise.all(
    context.pages().map(async (page) => {
      const batch = await drainPage(page, channelName, since);
      for (const ev of batch) out.push(ev);
    }),
  );
  // Stable ordering — events from different pages interleave by seq.
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** Back-fill `scriptSha256` for events by looking up their `scriptUrl`. */
export function attributeEvents(
  events: AnyRuntimeEvent[],
  urlToSha: Map<string, string>,
): void {
  for (const ev of events) {
    if (ev.scriptSha256) continue;
    if (!ev.scriptUrl) {
      ev.scriptSha256 = null;
      continue;
    }
    ev.scriptSha256 = urlToSha.get(ev.scriptUrl) ?? null;
  }
}

/**
 * D2 noise filter. Drops in-place every `via: "reflect"` access event
 * whose `scriptUrl` is `node_modules`-shaped (typical of vendored
 * libraries inside production bundles whose paths leak into the
 * served chunk URL). Events without a resolvable `scriptUrl` are
 * preserved — they may be detector code on a page whose origin
 * Playwright failed to attribute. Other event kinds are untouched.
 *
 * Returns the count of dropped events (useful for telemetry).
 */
const NODE_MODULES_FRAME = /\/node_modules\//;
export function filterReflectNoise(events: AnyRuntimeEvent[]): number {
  let dropped = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind !== "access") continue;
    if ((ev as RuntimeAccessEvent).via !== "reflect") continue;
    const url = ev.scriptUrl;
    if (!url) continue;
    if (NODE_MODULES_FRAME.test(url)) {
      events.splice(i, 1);
      dropped++;
    }
  }
  return dropped;
}

/**
 * Parse the first usable frame in a captured stack into URL/line/col.
 * Skips frames that look like they're from the trap script itself.
 */
export function parseStack(stack: string): { url: string | null; line: number | null; column: number | null } {
  if (!stack) return { url: null, line: null, column: null };
  const lines = stack.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    // V8 formats: "    at <fn> (url:line:col)" or "    at url:line:col"
    // Firefox formats: "<fn>@url:line:col"
    const m1 = /\(((?:https?:|file:|data:|blob:|chrome[-extension]*:)[^)]+):(\d+):(\d+)\)$/.exec(line);
    const m2 = /at ((?:https?:|file:|data:|blob:|chrome[-extension]*:)[^\s]+):(\d+):(\d+)$/.exec(line);
    const m3 = /@((?:https?:|file:|data:|blob:|chrome[-extension]*:)[^\s]+):(\d+):(\d+)$/.exec(line);
    const m = m1 ?? m2 ?? m3;
    if (m) {
      const url = m[1]!;
      // Skip our own injected init script frames if we can identify them.
      if (url.includes("__s2bRt") || url.startsWith("eval at trapMain")) continue;
      return { url, line: Number(m[2]), column: Number(m[3]) };
    }
  }
  return { url: null, line: null, column: null };
}

/**
 * Reconstruct {@link RawAccess} from runtime access events. Output
 * shape exactly mirrors what `script2builtins`' {@link walkProgram}
 * produces, so {@link matchAccesses} consumes it unchanged.
 */
export function toRawAccesses(events: AnyRuntimeEvent[]): RawAccess[] {
  const out: RawAccess[] = [];
  for (const ev of events) {
    if (ev.kind !== "access") continue;
    const a = ev as RuntimeAccessEvent;
    const loc: Location | null =
      a.line !== null && a.column !== null
        ? {
            start: { line: a.line, column: a.column },
            end: { line: a.line, column: a.column },
          }
        : null;
    out.push({
      chain: a.chain.slice(),
      called: a.called,
      loc,
      snippet: stackTopLine(a.stack),
      resolvedThroughObfuscation: false,
      hasDynamicSegment: false,
      firstStringArg: a.firstStringArg ?? null,
    });
  }
  return out;
}

/**
 * Reconstruct {@link NetworkSink} from runtime sink events.
 *
 * The trap captured a serialized preview of every request body. We
 * re-parse it here through the static analyzer's {@link parseRuntimeBody}
 * so the same `entries`/`leakedApis` shape is populated — this is the
 * pairing that lets `summary.leakedApiCount` reflect what actually
 * crossed the wire, not just what the static pass could see in
 * literals.
 */
export function toNetworkSinks(
  events: AnyRuntimeEvent[],
  apis: ApiDefinition[] = ALL_APIS,
): NetworkSink[] {
  const out: NetworkSink[] = [];
  for (const ev of events) {
    if (ev.kind !== "sink") continue;
    const s = ev as RuntimeSinkEvent;
    const loc: Location | null =
      s.line !== null && s.column !== null
        ? {
            start: { line: s.line, column: s.column },
            end: { line: s.line, column: s.column },
          }
        : null;
    out.push({
      kind: s.sinkKind,
      url: s.url,
      method: s.method,
      headers: s.headers,
      loc,
      snippet: stackTopLine(s.stack),
      payload: s.body
        ? parseRuntimeBody(
            { shape: s.body.shape, preview: s.body.preview, truncated: s.body.truncated },
            apis,
          )
        : null,
      originatingScriptSha256: s.scriptSha256,
    });
  }
  return out;
}

/** Reconstruct {@link DynamicHazard} from runtime hazard events. */
export function toDynamicHazards(events: AnyRuntimeEvent[]): DynamicHazard[] {
  const out: DynamicHazard[] = [];
  for (const ev of events) {
    if (ev.kind !== "hazard") continue;
    const h = ev as RuntimeHazardEvent;
    const loc: Location | null =
      h.line !== null && h.column !== null
        ? {
            start: { line: h.line, column: h.column },
            end: { line: h.line, column: h.column },
          }
        : null;
    const previewLen = Math.min(120, h.source.length);
    out.push({
      kind: hazardKindToStatic(h.hazardKind),
      loc,
      snippet: h.source.slice(0, previewLen),
      detail: `runtime ${h.hazardKind}${h.truncated ? " (source truncated)" : ""}`,
    });
  }
  return out;
}

function hazardKindToStatic(k: RuntimeHazardEvent["hazardKind"]): DynamicHazard["kind"] {
  switch (k) {
    case "eval":
      return "eval";
    case "Function":
      return "Function";
    case "setTimeout-string":
      return "setTimeout-string";
    case "setInterval-string":
      return "setInterval-string";
    case "import-call":
      return "import-call";
    case "document-write":
      return "document-write";
  }
}

function stackTopLine(stack: string): string {
  const i = stack.indexOf("\n");
  return i === -1 ? stack : stack.slice(0, i);
}
