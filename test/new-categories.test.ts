import { describe, expect, it } from "vitest";
import { analyze } from "../src/index.js";

function keys(r: ReturnType<typeof analyze>): string[] {
  return r.findings.map((f) => f.api.key);
}

describe("intl: Intl.* surface beyond DateTimeFormat/NumberFormat/Collator", () => {
  it("detects Intl.DisplayNames as a locale-system tell", () => {
    const r = analyze("new Intl.DisplayNames(['en'], {type:'language'}).of('fr');");
    expect(keys(r)).toContain("Intl.DisplayNames");
    expect(r.findings.find((f) => f.api.key === "Intl.DisplayNames")!.api.botDetectionTell).toBe(true);
  });

  it("detects Intl.RelativeTimeFormat and ListFormat", () => {
    const r = analyze("new Intl.RelativeTimeFormat('en').format(1, 'day'); new Intl.ListFormat('en').format(['a','b']);");
    expect(keys(r)).toEqual(expect.arrayContaining(["Intl.RelativeTimeFormat", "Intl.ListFormat"]));
  });

  it("detects Intl.PluralRules and Intl.Segmenter", () => {
    const r = analyze("new Intl.PluralRules('en').select(1); new Intl.Segmenter('en').segment('hi');");
    expect(keys(r)).toEqual(expect.arrayContaining(["Intl.PluralRules", "Intl.Segmenter"]));
  });

  it("Intl.* moved out of `timing` category", () => {
    const r = analyze("Intl.DateTimeFormat;");
    const f = r.findings.find((f) => f.api.key === "Intl.DateTimeFormat");
    expect(f?.api.category).toBe("intl");
  });
});

describe("speech: speechSynthesis fingerprint surface", () => {
  it("detects speechSynthesis.getVoices as a high tell", () => {
    const r = analyze("var v = speechSynthesis.getVoices();");
    const f = r.findings.find((f) => f.api.key === "speechSynthesis.getVoices");
    expect(f).toBeDefined();
    expect(f!.api.severity).toBe("high");
    expect(f!.api.botDetectionTell).toBe(true);
  });

  it("matches aliased getVoices", () => {
    const r = analyze("var s = speechSynthesis; var v = s.getVoices();");
    expect(keys(r)).toEqual(expect.arrayContaining(["speechSynthesis.getVoices"]));
  });
});

describe("math: precision-fingerprint surfaces", () => {
  it("flags Math.tan, Math.acos, Math.atanh as bot tells", () => {
    const r = analyze("Math.tan(-1e300); Math.acos(0.5); Math.atanh(0.5);");
    const found = keys(r);
    expect(found).toEqual(expect.arrayContaining(["Math.tan", "Math.acos", "Math.atanh"]));
    expect(r.findings.find((f) => f.api.key === "Math.tan")!.api.botDetectionTell).toBe(true);
  });
});

describe("workers + OffscreenCanvas", () => {
  it("detects Worker, SharedWorker, OffscreenCanvas, importScripts", () => {
    const r = analyze(`
      new Worker(url);
      new SharedWorker(url);
      var oc = new OffscreenCanvas(256, 256);
      importScripts(more);
    `);
    expect(keys(r)).toEqual(expect.arrayContaining(["Worker", "SharedWorker", "OffscreenCanvas", "importScripts"]));
  });
});

describe("wasm + SharedArrayBuffer + Atomics", () => {
  it("detects WebAssembly.compile, .instantiate, .Memory, .Module", () => {
    const r = analyze("WebAssembly.compile(bytes); WebAssembly.instantiate(bytes); new WebAssembly.Memory({initial:1}); new WebAssembly.Module(b);");
    expect(keys(r)).toEqual(expect.arrayContaining([
      "WebAssembly.compile",
      "WebAssembly.instantiate",
      "WebAssembly.Memory",
      "WebAssembly.Module",
    ]));
  });

  it("detects SharedArrayBuffer + Atomics primitives as timing-attack surface", () => {
    const r = analyze("var s = new SharedArrayBuffer(16); var v = new Int32Array(s); Atomics.add(v,0,1); Atomics.load(v,0); Atomics.wait(v,0,0);");
    expect(keys(r)).toEqual(expect.arrayContaining(["SharedArrayBuffer", "Atomics.add", "Atomics.load", "Atomics.wait"]));
    const sab = r.findings.find((f) => f.api.key === "SharedArrayBuffer")!;
    expect(sab.api.severity).toBe("high");
    expect(sab.api.botDetectionTell).toBe(true);
  });
});

describe("WebGL DRAWNAPART-style timing", () => {
  it("matches the EXT_disjoint_timer_query specialization of getExtension", () => {
    const r = analyze("gl.getExtension('EXT_disjoint_timer_query');");
    const specific = r.findings.find(
      (f) => f.api.key === "*.getExtension" && f.api.argMatch?.includes("EXT_disjoint_timer_query"),
    );
    expect(specific).toBeDefined();
    expect(specific!.api.severity).toBe("high");
  });

  it("detects createQuery / beginQuery / endQuery / getQueryParameter", () => {
    const r = analyze("var q = gl.createQuery(); gl.beginQuery(t, q); gl.endQuery(t); gl.getQueryParameter(q, p);");
    const found = keys(r);
    expect(found).toEqual(expect.arrayContaining(["*.createQuery", "*.beginQuery", "*.endQuery", "*.getQueryParameter"]));
  });
});

describe("WebRTC RTCRtpSender.getCapabilities", () => {
  it("detects RTCRtpSender / RTCRtpReceiver capability probes", () => {
    const r = analyze("RTCRtpSender.getCapabilities('video'); RTCRtpReceiver.getCapabilities('audio');");
    expect(keys(r)).toEqual(expect.arrayContaining(["RTCRtpSender", "RTCRtpReceiver"]));
  });
});

describe("MediaCapabilities + Speech high-signal probes", () => {
  it("detects decodingInfo and MediaSource.isTypeSupported", () => {
    const r = analyze("navigator.mediaCapabilities.decodingInfo(cfg); MediaSource.isTypeSupported('video/webm');");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.decodingInfo", "MediaSource.isTypeSupported"]));
  });
});

describe("CSS / computed-style probes", () => {
  it("detects getComputedStyle and CSS.supports as fingerprint tells", () => {
    const r = analyze("var cs = getComputedStyle(el); CSS.supports('color-scheme: dark');");
    expect(keys(r)).toEqual(expect.arrayContaining(["getComputedStyle", "CSS.supports"]));
  });

  it("detects inlineSize/blockSize font-metric leak", () => {
    const r = analyze("var w = getComputedStyle(el).inlineSize; var h = getComputedStyle(el).blockSize;");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.inlineSize", "*.blockSize"]));
  });
});

describe("SVG geometry fingerprint surface", () => {
  it("detects getBBox and getComputedTextLength", () => {
    const r = analyze("var b = svgEl.getBBox(); var l = textEl.getComputedTextLength();");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.getBBox", "*.getComputedTextLength"]));
  });
});

describe("navigator: new surfaces", () => {
  it("detects userAgentData.getHighEntropyValues", () => {
    const r = analyze("navigator.userAgentData.getHighEntropyValues(['architecture']);");
    expect(keys(r)).toContain("navigator.userAgentData.getHighEntropyValues");
  });

  it("detects navigator.brave and userActivation", () => {
    const r = analyze("if (navigator.brave) {} if (navigator.userActivation.hasBeenActive) {}");
    expect(keys(r)).toEqual(expect.arrayContaining(["navigator.brave", "navigator.userActivation"]));
  });

  it("detects WebGPU adapter info", () => {
    const r = analyze("navigator.gpu.requestAdapter().then(a => a.requestAdapterInfo());");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.requestAdapter", "*.requestAdapterInfo"]));
  });
});

describe("events: input-trust fingerprint", () => {
  it("detects Event.isTrusted, PointerEvent.pressure, MouseEvent.movementX", () => {
    const r = analyze("if (ev.isTrusted) {} var p = pev.pressure; var mx = mev.movementX;");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.isTrusted", "*.pressure", "*.movementX"]));
  });
});

describe("iframe cross-realm escape", () => {
  it("detects contentWindow / contentDocument access (leaf form)", () => {
    // `*.contentWindow` is a chain-tail wildcard, so it fires only when
    // contentWindow is the LEAF of the access chain.
    const r = analyze("var w = iframe.contentWindow; var d = iframe.contentDocument;");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.contentWindow", "*.contentDocument"]));
  });
});

describe("headless-tells: expanded automation markers", () => {
  it("flags Playwright / Puppeteer / Selenium globals", () => {
    const r = analyze("if (window.__pwInitScripts) {} if (window.__puppeteer_evaluation_script__) {} if (window.Selenium) {}");
    expect(keys(r)).toEqual(expect.arrayContaining([
      "__pwInitScripts",
      "__puppeteer_evaluation_script__",
      "Selenium",
    ]));
  });

  it("flags Node-environment leaks", () => {
    const r = analyze("if (typeof process !== 'undefined') {} if (typeof require === 'function') {} if (global) {}");
    expect(keys(r)).toEqual(expect.arrayContaining(["process", "require", "global"]));
  });
});

describe("introspection: stealth-defeat probes", () => {
  it("detects eval.toString and double-toString trick", () => {
    const r = analyze("eval.toString().length; Function.prototype.toString.toString();");
    expect(keys(r)).toEqual(expect.arrayContaining(["eval.toString", "*.toString.toString"]));
  });

  it("detects __lookupSetter__ / __lookupGetter__", () => {
    const r = analyze("Navigator.prototype.__lookupSetter__('webdriver');");
    expect(keys(r)).toContain("*.__lookupSetter__");
  });
});
