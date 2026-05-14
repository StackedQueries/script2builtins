import { describe, expect, it } from "vitest";
import { analyze } from "../src/index.js";
import type { NetworkSink, NetworkSinkKind } from "../src/types.js";

function sinksOfKind(report: ReturnType<typeof analyze>, kind: NetworkSinkKind): NetworkSink[] {
  return report.networkSinks.filter((s) => s.kind === kind);
}

function leakedKeys(sink: NetworkSink): string[] {
  return (sink.payload?.leakedApis ?? []).map((a) => a.key).sort();
}

describe("sinks: fetch", () => {
  it("captures URL, method, headers", () => {
    const r = analyze(`
      fetch("https://detector.example/c", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Token": "abc" },
        body: "{}",
      });
    `);
    const f = sinksOfKind(r, "fetch")[0]!;
    expect(f.url).toBe("https://detector.example/c");
    expect(f.method).toBe("POST");
    expect(f.headers["Content-Type"]).toBe("application/json");
    expect(f.headers["X-Token"]).toBe("abc");
  });

  it("defaults method to GET when init.method is absent", () => {
    const r = analyze('fetch("/x");');
    const f = sinksOfKind(r, "fetch")[0]!;
    expect(f.method).toBe("GET");
  });

  it("traces inline JSON.stringify({ ua: navigator.userAgent })", () => {
    const r = analyze(`
      fetch("/c", {
        method: "POST",
        body: JSON.stringify({ ua: navigator.userAgent, wd: navigator.webdriver }),
      });
    `);
    const f = sinksOfKind(r, "fetch")[0]!;
    expect(f.payload?.shape).toBe("json");
    expect(leakedKeys(f)).toEqual(["navigator.userAgent", "navigator.webdriver"]);
  });

  it("traces JSON.stringify of a previously-bound variable", () => {
    const r = analyze(`
      var data = { ua: navigator.userAgent, plg: navigator.plugins };
      fetch("/c", { method: "POST", body: JSON.stringify(data) });
    `);
    const f = sinksOfKind(r, "fetch")[0]!;
    expect(leakedKeys(f)).toEqual(["navigator.plugins", "navigator.userAgent"]);
  });

  it("records dynamic URL via urlSnippet when not statically resolvable", () => {
    const r = analyze('var p = "/c"; fetch(window.HOST + p);');
    const f = sinksOfKind(r, "fetch")[0]!;
    expect(f.url).toBeNull();
    expect(f.urlSnippet).toBeTruthy();
  });
});

describe("sinks: XMLHttpRequest", () => {
  it("correlates open/setRequestHeader/send across statements", () => {
    const r = analyze(`
      var x = new XMLHttpRequest();
      x.open("POST", "https://d.example/a");
      x.setRequestHeader("X-K", "v");
      x.send(JSON.stringify({ ua: navigator.userAgent }));
    `);
    const xhr = sinksOfKind(r, "xhr")[0]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("https://d.example/a");
    expect(xhr.headers["X-K"]).toBe("v");
    expect(leakedKeys(xhr)).toEqual(["navigator.userAgent"]);
  });
});

describe("sinks: sendBeacon + FormData", () => {
  it("traces FormData appends on a tracked var", () => {
    const r = analyze(`
      var fd = new FormData();
      fd.append("ua", navigator.userAgent);
      fd.append("wd", navigator.webdriver);
      fd.append("dpr", window.devicePixelRatio);
      navigator.sendBeacon("/b", fd);
    `);
    const sb = sinksOfKind(r, "sendBeacon")[0]!;
    expect(sb.payload?.shape).toBe("formdata");
    expect(leakedKeys(sb)).toEqual(["devicePixelRatio", "navigator.userAgent", "navigator.webdriver"]);
  });
});

describe("sinks: WebSocket", () => {
  it("emits both an open sink and a send sink", () => {
    const r = analyze(`
      var ws = new WebSocket("wss://e/x");
      ws.send(JSON.stringify({ ua: navigator.userAgent }));
    `);
    const open = sinksOfKind(r, "websocket-open")[0]!;
    const send = sinksOfKind(r, "websocket-send")[0]!;
    expect(open.url).toBe("wss://e/x");
    expect(send.url).toBe("wss://e/x");
    expect(leakedKeys(send)).toContain("navigator.userAgent");
  });
});

describe("sinks: image-src + URL query", () => {
  it("parses query string as payload entries", () => {
    const r = analyze('new Image().src = "https://e/p?wd=1&ua=foo&v=2";');
    const img = sinksOfKind(r, "image-src")[0]!;
    expect(img.payload?.shape).toBe("url-query");
    const keys = (img.payload?.entries ?? []).map((e) => e.key).sort();
    expect(keys).toEqual(["ua", "v", "wd"]);
  });

  it("createElement('img').src is also an image sink", () => {
    const r = analyze('document.createElement("img").src = "https://e/p?x=1";');
    expect(sinksOfKind(r, "image-src").length).toBe(1);
  });

  it("createElement('script').src is a script sink", () => {
    const r = analyze('document.createElement("script").src = "https://e/lib.js";');
    expect(sinksOfKind(r, "script-src").length).toBe(1);
  });
});

describe("sinks: workers + EventSource + importScripts + navigation", () => {
  it("captures Worker / SharedWorker / EventSource construction", () => {
    const r = analyze(`
      new Worker("/w.js");
      new SharedWorker("/sw.js");
      new EventSource("/sse");
    `);
    expect(sinksOfKind(r, "worker")[0]!.url).toBe("/w.js");
    expect(sinksOfKind(r, "shared-worker")[0]!.url).toBe("/sw.js");
    expect(sinksOfKind(r, "eventsource")[0]!.url).toBe("/sse");
  });

  it("emits one importScripts sink per URL argument", () => {
    const r = analyze('importScripts("/a.js", "/b.js");', { sourceType: "script" });
    expect(sinksOfKind(r, "importScripts").length).toBe(2);
  });

  it("captures location.href, location.assign, location.replace", () => {
    const r = analyze(`
      location.href = "/redir?wd=1";
      location.assign("/a");
      location.replace("/b");
    `);
    expect(sinksOfKind(r, "navigation").length).toBe(3);
  });
});

describe("sinks: leaked-API summary", () => {
  it("dedupes across sinks", () => {
    const r = analyze(`
      fetch("/a", { method: "POST", body: JSON.stringify({ ua: navigator.userAgent }) });
      navigator.sendBeacon("/b", JSON.stringify({ ua: navigator.userAgent, wd: navigator.webdriver }));
    `);
    expect(r.summary.leakedApiCount).toBe(2); // userAgent once, webdriver once
    expect(r.summary.sinkCount).toBe(2);
  });
});
