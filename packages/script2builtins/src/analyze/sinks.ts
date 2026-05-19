import type { Program } from "acorn";
import { simple as walkSimple } from "acorn-walk";
import type {
  NetworkSink,
  NetworkSinkKind,
  PayloadInfo,
  PayloadEntry,
  ApiDefinition,
} from "../types.js";
import { resolveChain, resolveProperty, resolveStaticString, type AliasMap } from "./aliases.js";
import { locOf } from "./util.js";
import {
  buildValues,
  classifyValue,
  type ValueMap,
  type ValueOrigin,
  type ValueEntry,
} from "./values.js";
import {
  classifyEndpointUrl,
  classifyEndpointPayloadKeys,
} from "script2builtins-knowledge";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SinkScanOptions {
  source: string;
  apis: ApiDefinition[];
}

/**
 * Walk the program for every way it can ship data off the page, and
 * attach a best-effort static analysis of what's in the body.
 *
 * The detector covers the common sinks: fetch, XMLHttpRequest,
 * navigator.sendBeacon, WebSocket, EventSource, Image/script src
 * writes, importScripts, Worker constructors, location navigation.
 *
 * For each sink, the body argument (if any) is run through a small
 * value-tracker that resolves object literals, JSON.stringify of
 * tracked variables, FormData accumulators, URLSearchParams entries,
 * and URL query strings. Each entry is matched against the API catalog
 * to surface exactly which fingerprint surfaces leak out.
 */
export function scanSinks(
  program: Program,
  aliases: AliasMap,
  opts: SinkScanOptions,
): NetworkSink[] {
  const values = buildValues(program, aliases, opts.source);
  const sinks: NetworkSink[] = [];

  // Track XHR-like instances across statements.
  const xhrInstances = new Map<string, { method: string | null; url: string | null; urlSnippet?: string; headers: Record<string, string | null> }>();
  const wsInstances = new Map<string, { url: string | null; urlSnippet?: string }>();

  // First pass: discover XHR/WS instance vars.
  walkSimple(program, {
    VariableDeclarator(node) {
      const d = node as any;
      if (d.id?.type !== "Identifier" || !d.init) return;
      const init = d.init;
      if (init.type === "NewExpression" && init.callee?.type === "Identifier") {
        const name = init.callee.name;
        if (name === "XMLHttpRequest" || name === "XDomainRequest") {
          xhrInstances.set(d.id.name, { method: null, url: null, headers: {} });
        } else if (name === "WebSocket") {
          const urlArg = init.arguments?.[0];
          const url = urlArg ? resolveStaticString(urlArg, aliases) : null;
          wsInstances.set(d.id.name, {
            url,
            urlSnippet: urlArg ? snippet(urlArg, opts.source) : undefined,
          });
          sinks.push({
            kind: "websocket-open",
            url,
            urlSnippet: urlArg ? snippet(urlArg, opts.source) : undefined,
            method: null,
            headers: {},
            loc: locOf(init),
            snippet: snippet(init, opts.source),
            payload: null,
          });
        }
      }
    },
  });

  // Second pass: emit sinks per call expression.
  walkSimple(program, {
    CallExpression(node) {
      const c = node as any;
      const callee = c.callee;
      if (!callee) return;

      // fetch(url, init?)
      const calleeName = identifierLikeName(callee, aliases);
      if (calleeName === "fetch") {
        const urlArg = c.arguments?.[0];
        const initArg = c.arguments?.[1];
        sinks.push(buildFetchSink(c, urlArg, initArg, aliases, values, opts));
        return;
      }

      if (calleeName === "importScripts") {
        for (const a of c.arguments ?? []) {
          const url = resolveStaticString(a, aliases);
          sinks.push({
            kind: "importScripts",
            url,
            urlSnippet: url ? undefined : snippet(a, opts.source),
            method: "GET",
            headers: {},
            loc: locOf(c),
            snippet: snippet(c, opts.source),
            payload: null,
          });
        }
        return;
      }

      // navigator.sendBeacon(url, body)
      if (callee.type === "MemberExpression") {
        const propName = !callee.computed && callee.property?.type === "Identifier" ? callee.property.name : null;
        const objChain = resolveChain(callee.object, aliases);

        if (propName === "sendBeacon" && objChain && objChain[objChain.length - 1] === "navigator") {
          const urlArg = c.arguments?.[0];
          const bodyArg = c.arguments?.[1];
          const url = urlArg ? resolveStaticString(urlArg, aliases) : null;
          sinks.push({
            kind: "sendBeacon",
            url,
            urlSnippet: urlArg && url === null ? snippet(urlArg, opts.source) : undefined,
            method: "POST",
            headers: {},
            loc: locOf(c),
            snippet: snippet(c, opts.source),
            payload: bodyArg ? tracePayload(bodyArg, aliases, values, opts) : null,
          });
          return;
        }

        // xhr.open / xhr.setRequestHeader / xhr.send on a tracked XHR instance
        if (callee.object?.type === "Identifier" && xhrInstances.has(callee.object.name)) {
          const inst = xhrInstances.get(callee.object.name)!;
          if (propName === "open") {
            inst.method = (resolveStaticString(c.arguments?.[0], aliases) ?? "").toUpperCase() || null;
            const urlArg = c.arguments?.[1];
            inst.url = urlArg ? resolveStaticString(urlArg, aliases) : null;
            if (urlArg && inst.url === null) inst.urlSnippet = snippet(urlArg, opts.source);
            return;
          }
          if (propName === "setRequestHeader") {
            const k = resolveStaticString(c.arguments?.[0], aliases);
            const v = resolveStaticString(c.arguments?.[1], aliases);
            if (k !== null) inst.headers[k] = v;
            return;
          }
          if (propName === "send") {
            const bodyArg = c.arguments?.[0];
            sinks.push({
              kind: "xhr",
              url: inst.url,
              urlSnippet: inst.urlSnippet,
              method: inst.method,
              headers: { ...inst.headers },
              loc: locOf(c),
              snippet: snippet(c, opts.source),
              payload: bodyArg ? tracePayload(bodyArg, aliases, values, opts) : null,
            });
            return;
          }
        }

        // ws.send(body) on a tracked WebSocket
        if (callee.object?.type === "Identifier" && wsInstances.has(callee.object.name) && propName === "send") {
          const inst = wsInstances.get(callee.object.name)!;
          const bodyArg = c.arguments?.[0];
          sinks.push({
            kind: "websocket-send",
            url: inst.url,
            urlSnippet: inst.urlSnippet,
            method: null,
            headers: {},
            loc: locOf(c),
            snippet: snippet(c, opts.source),
            payload: bodyArg ? tracePayload(bodyArg, aliases, values, opts) : null,
          });
          return;
        }

        // location.assign(url) / location.replace(url)
        if ((propName === "assign" || propName === "replace") && objChain && objChain[objChain.length - 1] === "location") {
          const urlArg = c.arguments?.[0];
          const url = urlArg ? resolveStaticString(urlArg, aliases) : null;
          sinks.push({
            kind: "navigation",
            url,
            urlSnippet: urlArg && url === null ? snippet(urlArg, opts.source) : undefined,
            method: "GET",
            headers: {},
            loc: locOf(c),
            snippet: snippet(c, opts.source),
            payload: urlArg ? maybeQueryStringPayload(urlArg, aliases, values, opts) : null,
          });
          return;
        }
      }
    },

    NewExpression(node) {
      const n = node as any;
      const callee = n.callee;
      if (!callee || callee.type !== "Identifier") return;
      const name = callee.name;
      const urlArg = n.arguments?.[0];
      const url = urlArg ? resolveStaticString(urlArg, aliases) : null;

      if (name === "EventSource") {
        sinks.push({
          kind: "eventsource",
          url,
          urlSnippet: urlArg && url === null ? snippet(urlArg, opts.source) : undefined,
          method: "GET",
          headers: {},
          loc: locOf(n),
          snippet: snippet(n, opts.source),
          payload: null,
        });
      } else if (name === "Worker") {
        sinks.push({
          kind: "worker",
          url,
          urlSnippet: urlArg && url === null ? snippet(urlArg, opts.source) : undefined,
          method: "GET",
          headers: {},
          loc: locOf(n),
          snippet: snippet(n, opts.source),
          payload: null,
        });
      } else if (name === "SharedWorker") {
        sinks.push({
          kind: "shared-worker",
          url,
          urlSnippet: urlArg && url === null ? snippet(urlArg, opts.source) : undefined,
          method: "GET",
          headers: {},
          loc: locOf(n),
          snippet: snippet(n, opts.source),
          payload: null,
        });
      } else if (name === "Image") {
        // new Image() — payload arrives later via .src assignment, handled below.
      }
    },

    AssignmentExpression(node) {
      const a = node as any;
      if (a.operator !== "=") return;
      if (a.left?.type !== "MemberExpression") return;
      const propName = !a.left.computed && a.left.property?.type === "Identifier" ? a.left.property.name : null;

      // *.src = url  → image / script beacon
      if (propName === "src") {
        const url = resolveStaticString(a.right, aliases);
        // Best guess at element kind: heuristic based on the createElement chain.
        const kind = guessSrcElementKind(a.left.object, aliases);
        if (!kind) return;
        sinks.push({
          kind: kind === "img" ? "image-src" : "script-src",
          url,
          urlSnippet: url === null ? snippet(a.right, opts.source) : undefined,
          method: "GET",
          headers: {},
          loc: locOf(a),
          snippet: snippet(a, opts.source),
          payload: maybeQueryStringPayload(a.right, aliases, values, opts),
        });
        return;
      }

      // location = url, location.href = url
      if (a.left.computed === false) {
        const obj = a.left.object;
        const objChain = resolveChain(obj, aliases);
        const lastSeg = objChain ? objChain[objChain.length - 1] : null;
        if (
          (propName === "href" && lastSeg === "location") ||
          (propName === "location" && lastSeg && (lastSeg === "window" || lastSeg === "self" || lastSeg === "globalThis"))
        ) {
          const url = resolveStaticString(a.right, aliases);
          sinks.push({
            kind: "navigation",
            url,
            urlSnippet: url === null ? snippet(a.right, opts.source) : undefined,
            method: "GET",
            headers: {},
            loc: locOf(a),
            snippet: snippet(a, opts.source),
            payload: maybeQueryStringPayload(a.right, aliases, values, opts),
          });
        }
      }
    },
  });

  // Annotate every payload with leakedApis (resolved via the catalog),
  // and classify each sink against the known-endpoint table.
  for (const sink of sinks) {
    if (sink.payload) sink.payload.leakedApis = uniqueApis(matchEntriesToApis(sink.payload.entries, opts.apis));

    // Provider classification: URL match wins, payload-key match is the
    // fallback for opaque / customer-routed URLs.
    let provider = classifyEndpointUrl(sink.url);
    if (!provider && sink.payload) {
      provider = classifyEndpointPayloadKeys(sink.payload.entries.map((e) => e.key));
    }
    sink.provider = provider;
  }

  return sinks;
}

function buildFetchSink(
  call: any,
  urlArg: any,
  initArg: any,
  aliases: AliasMap,
  values: ValueMap,
  opts: SinkScanOptions,
): NetworkSink {
  const url = urlArg ? resolveStaticString(urlArg, aliases) : null;
  let method: string | null = null;
  const headers: Record<string, string | null> = {};
  let bodyNode: any = null;

  if (initArg?.type === "ObjectExpression") {
    for (const p of initArg.properties ?? []) {
      if (p.type !== "Property") continue;
      const key = p.computed ? resolveStaticString(p.key, aliases) : (p.key?.name ?? (typeof p.key?.value === "string" ? p.key.value : null));
      if (key === "method") method = (resolveStaticString(p.value, aliases) ?? "").toUpperCase() || null;
      if (key === "body") bodyNode = p.value;
      if (key === "headers" && p.value?.type === "ObjectExpression") {
        for (const hp of p.value.properties ?? []) {
          if (hp.type !== "Property") continue;
          const hk = hp.computed ? resolveStaticString(hp.key, aliases) : (hp.key?.name ?? (typeof hp.key?.value === "string" ? hp.key.value : null));
          if (hk === null || hk === undefined) continue;
          headers[String(hk)] = resolveStaticString(hp.value, aliases);
        }
      }
    }
  } else if (initArg?.type === "Identifier") {
    // fetch(url, opts) where opts is a tracked variable.
    const origin = values.origins.get(initArg.name);
    if (origin?.kind === "object-literal") {
      for (const e of origin.entries) {
        if (e.key === "method" && e.literalValue) method = String(e.literalValue).toUpperCase();
      }
    }
  }

  return {
    kind: "fetch",
    url,
    urlSnippet: urlArg && url === null ? snippet(urlArg, opts.source) : undefined,
    method: method ?? "GET",
    headers,
    loc: locOf(call),
    snippet: snippet(call, opts.source),
    payload: bodyNode ? tracePayload(bodyNode, aliases, values, opts) : null,
  };
}

/**
 * Resolve a body argument (or URL-with-query) to a structured payload
 * description. Recurses through JSON.stringify, tracked variables,
 * object literals, FormData accumulators, and URLSearchParams.
 */
export function tracePayload(
  node: any,
  aliases: AliasMap,
  values: ValueMap,
  opts: SinkScanOptions,
): PayloadInfo {
  const snip = snippet(node, opts.source);
  const empty = (shape: PayloadInfo["shape"]): PayloadInfo => ({
    shape,
    entries: [],
    leakedApis: [],
    snippet: snip,
  });

  // Direct string literal — no fingerprint surfaces.
  const lit = resolveStaticString(node, aliases);
  if (lit !== null) return { ...empty("string"), entries: [{ key: "<body>", sourceChain: null, literalValue: lit, snippet: snip }] };

  // Identifier — look up its origin and recurse.
  if (node?.type === "Identifier") {
    const origin = values.origins.get(node.name);
    if (origin) return payloadFromOrigin(origin, aliases, values, opts, snip);
    return empty("unknown");
  }

  // Inline classification of the expression itself.
  const origin = classifyValue(node, aliases, opts.source);
  if (origin) return payloadFromOrigin(origin, aliases, values, opts, snip);
  return empty("unknown");
}

function payloadFromOrigin(
  origin: ValueOrigin,
  aliases: AliasMap,
  values: ValueMap,
  opts: SinkScanOptions,
  snip: string,
): PayloadInfo {
  switch (origin.kind) {
    case "object-literal": {
      const entries = origin.entries.map((e) => entryToPayloadEntry(e, values, aliases, opts));
      return { shape: "object", entries, leakedApis: [], snippet: snip };
    }
    case "json-stringify": {
      let inner: PayloadInfo;
      // Prefer the tracked variable's accumulated origin over the bare
      // single-segment chain that `classifyValue` would produce for a
      // variable reference.
      if (origin.argName && values.origins.has(origin.argName)) {
        inner = payloadFromOrigin(values.origins.get(origin.argName)!, aliases, values, opts, snip);
      } else if (origin.argOrigin) {
        inner = payloadFromOrigin(origin.argOrigin, aliases, values, opts, snip);
      } else {
        inner = { shape: "json", entries: [], leakedApis: [], snippet: snip };
      }
      return { ...inner, shape: "json", snippet: snip };
    }
    case "formdata": {
      const entries = origin.appends.map((e) => entryToPayloadEntry(e, values, aliases, opts));
      return { shape: "formdata", entries, leakedApis: [], snippet: snip };
    }
    case "urlsearchparams": {
      const entries = origin.appends.map((e) => entryToPayloadEntry(e, values, aliases, opts));
      return { shape: "urlsearchparams", entries, leakedApis: [], snippet: snip };
    }
    case "literal":
      return {
        shape: "string",
        entries: [{ key: "<body>", sourceChain: null, literalValue: origin.value, snippet: snip }],
        leakedApis: [],
        snippet: snip,
      };
    case "chain":
      return {
        shape: "string",
        entries: [{ key: "<body>", sourceChain: origin.chain, snippet: snip }],
        leakedApis: [],
        snippet: snip,
      };
    case "unknown":
      return { shape: "unknown", entries: [], leakedApis: [], snippet: snip };
  }
}

function entryToPayloadEntry(
  e: ValueEntry,
  values: ValueMap,
  aliases: AliasMap,
  opts: SinkScanOptions,
): PayloadEntry {
  if (e.literalValue !== undefined) {
    return { key: e.key, sourceChain: null, literalValue: e.literalValue, snippet: e.snippet };
  }
  if (e.chain && e.chain.length > 0) {
    return { key: e.key, sourceChain: e.chain, snippet: e.snippet };
  }
  if (e.refName) {
    // Follow ref to its origin.
    const origin = values.origins.get(e.refName);
    if (origin?.kind === "chain") return { key: e.key, sourceChain: origin.chain, snippet: e.snippet };
    if (origin?.kind === "literal") return { key: e.key, sourceChain: null, literalValue: origin.value, snippet: e.snippet };
  }
  return { key: e.key, sourceChain: null, snippet: e.snippet };
}

/**
 * URL with `?key=value&...` segment — treat the query string as a
 * payload of literal entries. Doesn't trace template-literal
 * substitutions yet (that's a known gap).
 */
function maybeQueryStringPayload(
  node: any,
  aliases: AliasMap,
  _values: ValueMap,
  opts: SinkScanOptions,
): PayloadInfo | null {
  const url = resolveStaticString(node, aliases);
  if (!url) return null;
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return null;
  const qs = url.slice(qIdx + 1);
  const entries: PayloadEntry[] = [];
  for (const part of qs.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const rawK = eq >= 0 ? part.slice(0, eq) : part;
    const rawV = eq >= 0 ? part.slice(eq + 1) : "";
    // Malformed percent-escapes throw URIError; fall back to raw bytes
    // so a single bad input can't crash analysis of the whole script.
    const k = safeDecode(rawK);
    const v = safeDecode(rawV);
    entries.push({ key: k, sourceChain: null, literalValue: v, snippet: `${k}=${v}` });
  }
  return { shape: "url-query", entries, leakedApis: [], snippet: snippet(node, opts.source) };
}

function matchEntriesToApis(entries: PayloadEntry[], apis: ApiDefinition[]): ApiDefinition[] {
  const out: ApiDefinition[] = [];
  for (const e of entries) {
    if (!e.sourceChain) continue;
    const api = matchChainToApi(e.sourceChain, apis);
    if (api) {
      e.leakedApi = api;
      out.push(api);
    }
  }
  return out;
}

function matchChainToApi(chain: (string | null)[], apis: ApiDefinition[]): ApiDefinition | undefined {
  // Strip leading globals.
  const cleaned = stripGlobalHead(chain);
  for (const api of apis) {
    const parts = api.key.split(".");
    if (parts[0] === "*") {
      const tail = parts.slice(1);
      if (cleaned.length < tail.length) continue;
      const start = cleaned.length - tail.length;
      let ok = true;
      for (let i = 0; i < tail.length; i++) if (cleaned[start + i] !== tail[i]) { ok = false; break; }
      if (ok) return api;
    } else {
      if (cleaned.length < parts.length) continue;
      let ok = true;
      for (let i = 0; i < parts.length; i++) if (cleaned[i] !== parts[i]) { ok = false; break; }
      if (ok) return api;
    }
  }
  return undefined;
}

const GLOBAL_ROOTS = new Set(["window", "self", "globalThis", "top", "parent", "frames"]);

function stripGlobalHead(chain: (string | null)[]): (string | null)[] {
  let i = 0;
  while (i < chain.length - 1) {
    const seg = chain[i];
    if (typeof seg === "string" && GLOBAL_ROOTS.has(seg)) { i++; continue; }
    break;
  }
  return chain.slice(i);
}

function uniqueApis(apis: ApiDefinition[]): ApiDefinition[] {
  const seen = new Set<string>();
  const out: ApiDefinition[] = [];
  for (const a of apis) {
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    out.push(a);
  }
  return out;
}

function identifierLikeName(node: any, aliases: AliasMap): string | null {
  if (!node) return null;
  if (node.type === "Identifier") {
    const aliased = aliases.chains.get(node.name);
    if (aliased && aliased.length === 1) return aliased[0] ?? node.name;
    return node.name;
  }
  if (node.type === "MemberExpression") return resolveProperty(node, aliases);
  return null;
}

function guessSrcElementKind(obj: any, aliases: AliasMap): "img" | "script" | null {
  // Heuristic: trace `obj` to a `document.createElement("X")` or `new Image()`.
  if (!obj) return null;
  if (obj.type === "NewExpression" && obj.callee?.type === "Identifier" && obj.callee.name === "Image") return "img";
  if (
    obj.type === "CallExpression" &&
    obj.callee?.type === "MemberExpression" &&
    !obj.callee.computed &&
    obj.callee.property?.type === "Identifier" &&
    obj.callee.property.name === "createElement"
  ) {
    const tag = resolveStaticString(obj.arguments?.[0], aliases)?.toLowerCase();
    if (tag === "img") return "img";
    if (tag === "script") return "script";
  }
  // Fall back: assume img-beacon for assignments that aren't obviously script.
  return null;
}

function snippet(node: any, source: string): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return "";
  const raw = source.slice(node.start, node.end);
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? oneLine.slice(0, 199) + "…" : oneLine;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Trap-side body description from script2builtins-runtime. */
export interface RuntimeBody {
  shape:
    | "string"
    | "json"
    | "formdata"
    | "urlsearchparams"
    | "blob"
    | "binary"
    | "empty";
  preview: string;
  truncated?: boolean;
}

/**
 * Parse a runtime-captured request body preview into a {@link PayloadInfo}.
 *
 * Mirrors the AST-driven payload tracer used by {@link scanSinks}, but
 * works from a serialized string the trap caught at send-time. Returns
 * the same `{shape, entries, leakedApis, snippet}` shape so runtime and
 * static sinks compose uniformly downstream.
 *
 * Shape handling:
 *   - `"empty"`/`"blob"`/`"binary"` → no entries (opaque).
 *   - `"urlsearchparams"`            → split `k=v&k=v`, decode.
 *   - `"formdata"`                   → JSON-decode the `[[k,v],…]` pair
 *                                      array the trap emits.
 *   - `"json"` or `"string"`         → try JSON.parse; if the result is
 *                                      a plain object, flatten one level
 *                                      (dot-joined keys for shallow
 *                                      nesting up to depth 3). Falls
 *                                      back to one `<body>` entry on
 *                                      parse failure.
 *
 * Matching: each key is treated as a synthetic suffix chain
 * (`[key]`) and run through the same wildcard-suffix matcher
 * {@link matchAccesses} uses. Mangled keys (`e.cv`, `b.h0`) will not
 * match — that's expected; the trap-side preview is just a serialized
 * snapshot of what crossed the wire.
 */
export function parseRuntimeBody(
  body: RuntimeBody,
  apis: ApiDefinition[],
): PayloadInfo {
  const snip = body.preview ?? "";
  const empty = (shape: PayloadInfo["shape"]): PayloadInfo => ({
    shape,
    entries: [],
    leakedApis: [],
    snippet: snip,
  });

  switch (body.shape) {
    case "empty":
    case "blob":
    case "binary":
      // `binary` isn't a PayloadInfo shape — surface as "unknown" so
      // downstream renderers don't trip on an unmapped value.
      return empty(body.shape === "binary" || body.shape === "empty" ? "unknown" : "blob");

    case "urlsearchparams": {
      const entries = decodeUrlEncoded(body.preview);
      return finish("urlsearchparams", entries, snip, apis);
    }

    case "formdata": {
      const entries = decodeFormDataPairs(body.preview);
      return finish("formdata", entries, snip, apis);
    }

    case "json":
    case "string": {
      // Treat the preview as JSON first; many payloads (most modern
      // beacons) are JSON regardless of how the body was constructed.
      const parsed = tryParseJson(body.preview);
      if (parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = flattenObject(parsed as Record<string, unknown>);
        return finish("json", entries, snip, apis);
      }
      // Fall back: maybe url-form-encoded inside a string body.
      if (looksUrlEncoded(body.preview)) {
        const entries = decodeUrlEncoded(body.preview);
        if (entries.length > 0) return finish("urlsearchparams", entries, snip, apis);
      }
      // Otherwise: a single opaque body entry — preserve the literal so
      // a downstream eyeballer can still see it.
      return {
        shape: "string",
        entries: [{ key: "<body>", sourceChain: null, literalValue: body.preview, snippet: snip }],
        leakedApis: [],
        snippet: snip,
      };
    }
  }
}

function finish(
  shape: PayloadInfo["shape"],
  entries: PayloadEntry[],
  snip: string,
  apis: ApiDefinition[],
): PayloadInfo {
  // Two-stage matching. Multi-segment chains (e.g. `["screen", "width"]`
  // from nested JSON) try a direct prefix match first so the canonical
  // catalog entry wins. Single-segment chains skip the direct path —
  // it would otherwise match a bare-global catalog entry (`webdriver`)
  // ahead of the more canonical `navigator.webdriver`. Either way the
  // tail-name matcher acts as the fallback.
  const leaked: ApiDefinition[] = [];
  for (const e of entries) {
    if (!e.sourceChain || e.sourceChain.length === 0) continue;
    let api: ApiDefinition | undefined;
    if (e.sourceChain.length >= 2) {
      api = matchChainToApi(e.sourceChain, apis);
    }
    if (!api) {
      const leaf = e.sourceChain[e.sourceChain.length - 1];
      if (typeof leaf === "string" && leaf.length > 0) {
        api = matchByLeafName(leaf, apis);
      }
    }
    if (api) {
      e.leakedApi = api;
      leaked.push(api);
    }
  }
  return { shape, entries, leakedApis: uniqueApis(leaked), snippet: snip };
}

/**
 * For runtime entries that only carry a leaf key (the body was already
 * serialized when we trapped it), match against any catalog API whose
 * own key ends in that segment.
 *
 * The catalog has multiple entries that end in the same leaf — e.g.
 * `platform` appears as `navigator.platform`, `navigator.userAgentData.platform`,
 * and `*.platform`. Picking is heuristic; the tiers favor the
 * canonical `category.leaf` shape (matches how detector payloads
 * actually name keys) over nested or wildcard variants.
 *
 *   Tier 1: concrete length-2 (`navigator.platform`)         ← canonical
 *   Tier 2: concrete length≥3 (`navigator.userAgentData.platform`)
 *   Tier 3: wildcard           (`*.platform`)
 *   Tier 4: bare global        (`platform`)
 *
 * `__proto__`-containing keys are dropped at the gate — they describe
 * an introspection path, not a payload-key target.
 */
function matchByLeafName(leaf: string, apis: ApiDefinition[]): ApiDefinition | undefined {
  let tier1: ApiDefinition | undefined;
  let tier2: { api: ApiDefinition; len: number } | undefined;
  let tier3: ApiDefinition | undefined;
  let tier4: ApiDefinition | undefined;
  for (const api of apis) {
    const parts = api.key.split(".");
    if (parts[parts.length - 1] !== leaf) continue;
    if (parts.indexOf("__proto__") >= 0) continue;
    const len = parts.length;
    const isWildcard = parts[0] === "*";
    if (!isWildcard && len === 2) {
      if (!tier1) tier1 = api;
    } else if (!isWildcard && len >= 3) {
      if (!tier2 || len < tier2.len) tier2 = { api, len };
    } else if (isWildcard) {
      if (!tier3) tier3 = api;
    } else if (len === 1) {
      if (!tier4) tier4 = api;
    }
  }
  return tier1 ?? tier2?.api ?? tier3 ?? tier4;
}

function tryParseJson(s: string): unknown {
  if (!s) return undefined;
  // Cheap pre-check: JSON.parse on huge non-JSON strings is wasteful.
  const trimmed = s.trim();
  const first = trimmed.charCodeAt(0);
  if (first !== 0x7b /* { */ && first !== 0x5b /* [ */) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix: string = "",
  depth: number = 0,
  out: PayloadEntry[] = [],
): PayloadEntry[] {
  const MAX_DEPTH = 3;
  const MAX_ENTRIES = 200;
  for (const [k, v] of Object.entries(obj)) {
    if (out.length >= MAX_ENTRIES) break;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < MAX_DEPTH) {
      flattenObject(v as Record<string, unknown>, key, depth + 1, out);
      continue;
    }
    // Use the leaf name as the matcher chain (e.g. `nested.userAgent`
    // still surfaces `userAgent` because the wildcard suffix matcher
    // works on the trailing segment).
    const leafChain = key.split(".");
    const literal =
      typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
        ? (v as string | number | boolean | null)
        : undefined;
    out.push({
      key,
      sourceChain: leafChain,
      literalValue: literal,
      snippet: literal === undefined ? `[${typeof v}]` : String(literal).slice(0, 80),
    });
  }
  return out;
}

function decodeUrlEncoded(s: string): PayloadEntry[] {
  const out: PayloadEntry[] = [];
  if (!s) return out;
  for (const part of s.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    let k: string;
    let v: string;
    try {
      k = eq >= 0 ? decodeURIComponent(part.slice(0, eq)) : decodeURIComponent(part);
      v = eq >= 0 ? decodeURIComponent(part.slice(eq + 1)) : "";
    } catch {
      // Malformed escapes — fall back to raw bytes.
      k = eq >= 0 ? part.slice(0, eq) : part;
      v = eq >= 0 ? part.slice(eq + 1) : "";
    }
    out.push({ key: k, sourceChain: [k], literalValue: v, snippet: `${k}=${v.slice(0, 60)}` });
  }
  return out;
}

function decodeFormDataPairs(s: string): PayloadEntry[] {
  // The trap emits JSON.stringify of an array of [key, value] pairs.
  const out: PayloadEntry[] = [];
  if (!s) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const pair of parsed) {
    if (!Array.isArray(pair) || pair.length < 1) continue;
    const k = typeof pair[0] === "string" ? pair[0] : String(pair[0]);
    const v = pair[1];
    const literal =
      typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
        ? (v as string | number | boolean | null)
        : undefined;
    out.push({
      key: k,
      sourceChain: [k],
      literalValue: literal,
      snippet: literal === undefined ? `${k}=[${typeof v}]` : `${k}=${String(literal).slice(0, 60)}`,
    });
  }
  return out;
}

function looksUrlEncoded(s: string): boolean {
  if (!s || s.length > 64 * 1024) return false;
  // Must have at least one `=` between non-empty key and value, and
  // not start with `{`/`[` (already ruled JSON above).
  if (s.charCodeAt(0) === 0x7b || s.charCodeAt(0) === 0x5b) return false;
  const eq = s.indexOf("=");
  if (eq <= 0) return false;
  // Reject anything with whitespace early in the string — real query
  // strings never have raw spaces.
  if (/\s/.test(s.slice(0, Math.min(64, s.length)))) return false;
  return true;
}
