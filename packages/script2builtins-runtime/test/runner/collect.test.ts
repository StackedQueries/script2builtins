import { describe, it, expect } from "vitest";
import {
  parseStack,
  attributeEvents,
  filterReflectNoise,
  toRawAccesses,
  toNetworkSinks,
  toDynamicHazards,
} from "../../src/runner/collect.js";
import type {
  RuntimeAccessEvent,
  RuntimeSinkEvent,
  RuntimeHazardEvent,
} from "../../src/types.js";

describe("parseStack", () => {
  it("parses V8 stacks", () => {
    const stack = `Error
    at foo (https://example.com/main.js:42:13)
    at bar (https://example.com/main.js:100:5)`;
    expect(parseStack(stack)).toEqual({
      url: "https://example.com/main.js",
      line: 42,
      column: 13,
    });
  });

  it("parses Firefox stacks", () => {
    const stack = `foo@https://example.com/main.js:42:13
bar@https://example.com/main.js:100:5`;
    expect(parseStack(stack)).toEqual({
      url: "https://example.com/main.js",
      line: 42,
      column: 13,
    });
  });

  it("returns nulls for unparseable input", () => {
    expect(parseStack("")).toEqual({ url: null, line: null, column: null });
    expect(parseStack("garbage")).toEqual({ url: null, line: null, column: null });
  });
});

describe("attributeEvents", () => {
  it("backfills scriptSha256 from url→sha map", () => {
    const events: RuntimeAccessEvent[] = [
      {
        kind: "access",
        seq: 0,
        t: 0,
        scriptUrl: "https://example.com/a.js",
        scriptSha256: null,
        line: null,
        column: null,
        stack: "",
        chain: ["navigator", "userAgent"],
        called: false,
        firstStringArg: null,
        via: "proxy",
      },
    ];
    const map = new Map([["https://example.com/a.js", "abc123"]]);
    attributeEvents(events, map);
    expect(events[0]!.scriptSha256).toBe("abc123");
  });

  it("leaves scriptSha256 null when URL is unknown", () => {
    const events: RuntimeAccessEvent[] = [
      {
        kind: "access",
        seq: 0,
        t: 0,
        scriptUrl: "https://example.com/x.js",
        scriptSha256: null,
        line: null,
        column: null,
        stack: "",
        chain: [],
        called: false,
        firstStringArg: null,
        via: "proxy",
      },
    ];
    attributeEvents(events, new Map());
    expect(events[0]!.scriptSha256).toBe(null);
  });
});

describe("filterReflectNoise (D2)", () => {
  function mkAccess(
    via: "proxy" | "descriptor" | "reflect" | "apply",
    scriptUrl: string | null,
  ): RuntimeAccessEvent {
    return {
      kind: "access",
      seq: 0,
      t: 0,
      scriptUrl,
      scriptSha256: null,
      line: null,
      column: null,
      stack: "",
      chain: ["navigator", "userAgent"],
      called: false,
      firstStringArg: null,
      via,
    };
  }

  it("drops reflect-via accesses from node_modules-shaped URLs", () => {
    const events = [
      mkAccess("reflect", "https://example.com/static/js/node_modules/lodash.js"),
      mkAccess("reflect", "https://example.com/detector.js"),
      mkAccess("proxy", "https://example.com/static/js/node_modules/react.js"),
      mkAccess("reflect", null),
    ];
    const dropped = filterReflectNoise(events);
    expect(dropped).toBe(1);
    expect(events).toHaveLength(3);
    // Order preserved for non-dropped entries.
    expect(events[0]!.scriptUrl).toBe("https://example.com/detector.js");
    expect(events[1]!.via).toBe("proxy");
    expect(events[2]!.scriptUrl).toBe(null);
  });

  it("never drops sink or hazard events", () => {
    const sink: any = { kind: "sink", scriptUrl: "https://x/node_modules/a.js" };
    const hazard: any = { kind: "hazard", scriptUrl: "https://x/node_modules/b.js" };
    const events = [sink, hazard];
    expect(filterReflectNoise(events)).toBe(0);
    expect(events).toHaveLength(2);
  });

  it("never drops descriptor or proxy access events even from node_modules", () => {
    const events = [
      mkAccess("descriptor", "https://x/node_modules/a.js"),
      mkAccess("proxy", "https://x/node_modules/b.js"),
      mkAccess("apply", "https://x/node_modules/c.js"),
    ];
    expect(filterReflectNoise(events)).toBe(0);
    expect(events).toHaveLength(3);
  });
});

describe("toRawAccesses", () => {
  it("converts access events to RawAccess shape", () => {
    const ev: RuntimeAccessEvent = {
      kind: "access",
      seq: 1,
      t: 0,
      scriptUrl: null,
      scriptSha256: null,
      line: 5,
      column: 10,
      stack: "at foo:5:10",
      chain: ["navigator", "webdriver"],
      called: false,
      firstStringArg: null,
      via: "proxy",
    };
    const raw = toRawAccesses([ev]);
    expect(raw).toHaveLength(1);
    expect(raw[0]!.chain).toEqual(["navigator", "webdriver"]);
    expect(raw[0]!.loc).toEqual({
      start: { line: 5, column: 10 },
      end: { line: 5, column: 10 },
    });
  });

  it("ignores non-access events", () => {
    const sink: RuntimeSinkEvent = {
      kind: "sink",
      seq: 2,
      t: 0,
      scriptUrl: null,
      scriptSha256: null,
      line: null,
      column: null,
      stack: "",
      sinkKind: "fetch",
      url: "/x",
      method: "GET",
      headers: {},
      body: null,
    };
    expect(toRawAccesses([sink])).toEqual([]);
  });
});

describe("toNetworkSinks", () => {
  it("converts sink events to NetworkSink shape", () => {
    const ev: RuntimeSinkEvent = {
      kind: "sink",
      seq: 0,
      t: 0,
      scriptUrl: null,
      scriptSha256: null,
      line: null,
      column: null,
      stack: "",
      sinkKind: "fetch",
      url: "https://example.com/collect",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { shape: "json", preview: '{"a":1}', truncated: false },
    };
    const sinks = toNetworkSinks([ev]);
    expect(sinks).toHaveLength(1);
    expect(sinks[0]!.kind).toBe("fetch");
    expect(sinks[0]!.url).toBe("https://example.com/collect");
    expect(sinks[0]!.payload?.shape).toBe("json");
    expect(sinks[0]!.payload?.snippet).toBe('{"a":1}');
  });

  it("re-parses the body preview so leakedApis populate for runtime sinks", () => {
    const ev: RuntimeSinkEvent = {
      kind: "sink",
      seq: 0,
      t: 0,
      scriptUrl: null,
      scriptSha256: null,
      line: null,
      column: null,
      stack: "",
      sinkKind: "fetch",
      url: "https://example.com/c",
      method: "POST",
      headers: {},
      body: {
        shape: "json",
        preview: JSON.stringify({
          userAgent: "Mozilla/5.0…",
          webdriver: true,
          deviceMemory: 8,
          unrelated: 1,
        }),
        truncated: false,
      },
    };
    const sinks = toNetworkSinks([ev]);
    const leaked = (sinks[0]!.payload?.leakedApis ?? []).map((a) => a.key).sort();
    expect(leaked).toContain("navigator.userAgent");
    expect(leaked).toContain("navigator.webdriver");
    expect(leaked).toContain("navigator.deviceMemory");
    expect(sinks[0]!.payload?.entries.length).toBe(4);
  });

  it("handles urlencoded bodies without crashing on malformed escapes", () => {
    const ev: RuntimeSinkEvent = {
      kind: "sink",
      seq: 0,
      t: 0,
      scriptUrl: null,
      scriptSha256: null,
      line: null,
      column: null,
      stack: "",
      sinkKind: "sendBeacon",
      url: "https://example.com/b",
      method: "POST",
      headers: {},
      body: {
        shape: "urlsearchparams",
        preview: "userAgent=%FFbroken&webdriver=true",
        truncated: false,
      },
    };
    const sinks = toNetworkSinks([ev]);
    expect(sinks[0]!.payload?.shape).toBe("urlsearchparams");
    const leaked = (sinks[0]!.payload?.leakedApis ?? []).map((a) => a.key);
    expect(leaked).toContain("navigator.userAgent");
    expect(leaked).toContain("navigator.webdriver");
  });
});

describe("toDynamicHazards", () => {
  it("converts hazard events to DynamicHazard shape", () => {
    const ev: RuntimeHazardEvent = {
      kind: "hazard",
      seq: 0,
      t: 0,
      scriptUrl: null,
      scriptSha256: null,
      line: null,
      column: null,
      stack: "",
      hazardKind: "eval",
      source: "var x = 1",
      truncated: false,
      sha256: "",
    };
    const hazards = toDynamicHazards([ev]);
    expect(hazards).toHaveLength(1);
    expect(hazards[0]!.kind).toBe("eval");
    expect(hazards[0]!.snippet).toBe("var x = 1");
    expect(hazards[0]!.detail).toContain("runtime eval");
  });
});
