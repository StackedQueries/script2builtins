/**
 * Regression tests for the IMPROVEMENTS.md Section A catalog adds.
 *
 * Each block ties back to the corresponding A-item so the linkage stays
 * obvious — when one of these fails, look at the same section of
 * IMPROVEMENTS.md for the intent.
 */
import { describe, expect, it } from "vitest";
import { analyze, renderText } from "../src/index.js";
import {
  classifyEndpointUrl,
  classifyEndpointPayloadKeys,
} from "../src/knowledge/endpoints.js";

function keys(r: ReturnType<typeof analyze>): string[] {
  return r.findings.map((f) => f.api.key);
}

describe("A1 — anti-debug & anti-logger catalog", () => {
  it("flags console.log / console.debug / console.warn / console.error as bot tells", () => {
    const r = analyze("console.log = trap; console.debug = trap; console.warn = trap; console.error = trap;");
    const found = keys(r);
    expect(found).toEqual(expect.arrayContaining([
      "console.log",
      "console.debug",
      "console.warn",
      "console.error",
    ]));
    for (const k of ["console.log", "console.debug", "console.warn", "console.error"]) {
      const f = r.findings.find((f) => f.api.key === k)!;
      expect(f.api.botDetectionTell).toBe(true);
      expect(f.api.category).toBe("anti-debug");
    }
  });

  it("flags console.table / console.dir / console.trace / console.profile as DevTools probes", () => {
    const r = analyze("console.table(x); console.dir(y); console.trace(); console.profile('x'); console.profileEnd(); console.timeStamp('m');");
    expect(keys(r)).toEqual(expect.arrayContaining([
      "console.table",
      "console.dir",
      "console.trace",
      "console.profile",
      "console.profileEnd",
      "console.timeStamp",
    ]));
  });

  it("flags console.clear as an anti-analysis behavior", () => {
    const r = analyze("console.clear();");
    const f = r.findings.find((f) => f.api.key === "console.clear")!;
    expect(f).toBeDefined();
    expect(f.api.botDetectionTell).toBe(true);
  });

  it("emits a debugger-statement hazard for `debugger;`", () => {
    const r = analyze("function trap(){ var a = performance.now(); debugger; var b = performance.now(); if (b - a > 100) seed ^= 0xdead; }");
    const kinds = r.hazards.map((h) => h.kind);
    expect(kinds).toContain("debugger-statement");
  });

  it("flags *.stack reads as introspection bot tells", () => {
    const r = analyze("try { foo(); } catch (e) { var s = e.stack; if (s.indexOf('puppeteer') >= 0) flag(); }");
    const f = r.findings.find((f) => f.api.key === "*.stack")!;
    expect(f).toBeDefined();
    expect(f.api.botDetectionTell).toBe(true);
  });

  it("flags Function.toString.call trampoline", () => {
    const r = analyze("var src = Function.toString.call(victim);");
    expect(keys(r)).toContain("Function.toString");
  });

  it("flags Function.prototype.bind / call / apply introspection axis", () => {
    const r = analyze("Function.prototype.bind; Function.prototype.call; Function.prototype.apply;");
    expect(keys(r)).toEqual(expect.arrayContaining([
      "Function.prototype.bind",
      "Function.prototype.call",
      "Function.prototype.apply",
    ]));
  });
});

describe("A2 — keystroke / wheel / pointer biometrics", () => {
  it("flags KeyboardEvent.code / .repeat as biometric tells", () => {
    const r = analyze("function k(e){ var c = e.code; var r = e.repeat; var k = e.key; }");
    const found = keys(r);
    expect(found).toEqual(expect.arrayContaining(["*.code", "*.repeat", "*.key"]));
    expect(r.findings.find((f) => f.api.key === "*.code")!.api.botDetectionTell).toBe(true);
    expect(r.findings.find((f) => f.api.key === "*.repeat")!.api.botDetectionTell).toBe(true);
  });

  it("flags WheelEvent.deltaX / deltaY as wheel-fingerprint tells", () => {
    const r = analyze("function w(e){ var dx = e.deltaX; var dy = e.deltaY; var dm = e.deltaMode; }");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.deltaX", "*.deltaY", "*.deltaMode"]));
    expect(r.findings.find((f) => f.api.key === "*.deltaX")!.api.botDetectionTell).toBe(true);
  });

  it("flags PointerEvent.pointerType as a consistency axis", () => {
    const r = analyze("function p(e){ if (e.pointerType !== 'touch') flag(); }");
    const f = r.findings.find((f) => f.api.key === "*.pointerType")!;
    expect(f).toBeDefined();
    expect(f.api.botDetectionTell).toBe(true);
  });

  it("flags InputEvent.inputType and Event.composedPath", () => {
    const r = analyze("function i(e){ var t = e.inputType; var p = e.composedPath(); }");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.inputType", "*.composedPath"]));
  });
});

describe("A3 — service-worker & cache surfaces", () => {
  it("flags caches.open / match / put / has", () => {
    const r = analyze("caches.open('v').then(c => { c.put(req, res); c.match(req); }); caches.has('v');");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.open", "*.match", "*.put", "*.has"]));
  });

  it("flags BroadcastChannel construction as suspicious in a detector", () => {
    const r = analyze("var bc = new BroadcastChannel('x'); bc.postMessage(payload);");
    const f = r.findings.find((f) => f.api.key === "BroadcastChannel")!;
    expect(f).toBeDefined();
    expect(f.api.botDetectionTell).toBe(true);
  });

  it("flags serviceWorker.register / .controller / .ready", () => {
    // The chain-tail wildcards fire when these are the leaf of the
    // access chain. We rely on the leaf-form matcher.
    const r = analyze("navigator.serviceWorker.register('/sw.js'); var c = navigator.serviceWorker.controller; var p = navigator.serviceWorker.ready;");
    const found = keys(r);
    expect(found).toEqual(expect.arrayContaining(["*.register", "*.controller", "*.ready"]));
  });
});

describe("A4 — WebRTC IP-leak handlers", () => {
  it("flags onicecandidate / localDescription / candidate as IP-leak markers", () => {
    const r = analyze("var pc = new RTCPeerConnection(); pc.onicecandidate = function(e){ var c = e.candidate; var ld = pc.localDescription; };");
    expect(keys(r)).toEqual(expect.arrayContaining([
      "*.onicecandidate",
      "*.localDescription",
      "*.candidate",
    ]));
    expect(r.findings.find((f) => f.api.key === "*.onicecandidate")!.api.botDetectionTell).toBe(true);
  });

  it("flags getStats() as network-path fingerprint", () => {
    const r = analyze("pc.getStats().then(s => process(s));");
    expect(keys(r)).toContain("*.getStats");
    expect(r.findings.find((f) => f.api.key === "*.getStats")!.api.botDetectionTell).toBe(true);
  });

  it("flags RTCDataChannel + *.sdp", () => {
    const r = analyze("var dc = new RTCDataChannel(); var s = pc.localDescription.sdp;");
    expect(keys(r)).toEqual(expect.arrayContaining(["RTCDataChannel", "*.sdp"]));
  });
});

describe("A6 — known anti-bot endpoint classifier", () => {
  it("classifyEndpointUrl recognizes Google Botguard endpoints", () => {
    expect(classifyEndpointUrl("https://play.google.com/log?format=json")).toBe("Google Botguard");
  });

  it("classifyEndpointUrl recognizes Cloudflare Turnstile", () => {
    expect(classifyEndpointUrl("https://challenges.cloudflare.com/turnstile/v0/api.js")).toBe(
      "Cloudflare Turnstile",
    );
  });

  it("classifyEndpointUrl recognizes DataDome", () => {
    expect(classifyEndpointUrl("https://js.datadome.co/tags.js")).toBe("DataDome");
  });

  it("classifyEndpointUrl returns null for unrelated URLs", () => {
    expect(classifyEndpointUrl("https://api.example.com/widget")).toBeNull();
    expect(classifyEndpointUrl(null)).toBeNull();
  });

  it("classifyEndpointPayloadKeys matches bgRequest as Botguard", () => {
    expect(classifyEndpointPayloadKeys(["bgRequest", "extra"])).toBe("Google Botguard");
  });

  it("classifyEndpointPayloadKeys matches sensor_data as Akamai", () => {
    expect(classifyEndpointPayloadKeys(["sensor_data"])).toBe("Akamai Bot Manager");
  });

  it("scanSinks sets provider on a fetch sink with a known URL", () => {
    const r = analyze("fetch('https://challenges.cloudflare.com/turnstile/v0/api.js');");
    expect(r.networkSinks.length).toBeGreaterThan(0);
    const fc = r.networkSinks.find((s) => s.provider === "Cloudflare Turnstile");
    expect(fc).toBeDefined();
    expect(r.summary.providers["Cloudflare Turnstile"]).toBeGreaterThanOrEqual(1);
  });

  it("scanSinks uses payload-key fallback for opaque URLs", () => {
    const r = analyze("fetch(dynamicUrl, { method: 'POST', body: JSON.stringify({ bgRequest: 'abc', extra: 1 }) });");
    const s = r.networkSinks.find((s) => s.provider === "Google Botguard");
    expect(s).toBeDefined();
    expect(r.summary.providers["Google Botguard"]).toBe(1);
  });
});

describe("A8 — browser-extension fingerprinting", () => {
  it("flags chrome.runtime.sendMessage / connect / id as extension probes", () => {
    const r = analyze("chrome.runtime.sendMessage('abcdef', {}); chrome.runtime.connect('abcdef'); var i = chrome.runtime.id;");
    expect(keys(r)).toEqual(expect.arrayContaining([
      "chrome.runtime.sendMessage",
      "chrome.runtime.connect",
      "chrome.runtime.id",
    ]));
    for (const k of ["chrome.runtime.sendMessage", "chrome.runtime.connect"]) {
      expect(r.findings.find((f) => f.api.key === k)!.api.botDetectionTell).toBe(true);
    }
  });

  it("flags chrome.webstore as a spoof tell", () => {
    const r = analyze("if (chrome.webstore) goofy();");
    const f = r.findings.find((f) => f.api.key === "chrome.webstore")!;
    expect(f).toBeDefined();
    expect(f.api.botDetectionTell).toBe(true);
  });

  it("flags *.cssRules iteration as a style-injection probe", () => {
    const r = analyze("for (var i = 0; i < document.styleSheets.length; i++) { var rules = document.styleSheets[i].cssRules; }");
    expect(keys(r)).toContain("*.cssRules");
  });
});

/**
 * Section B regression tests — structural / pattern detectors.
 * Each block ties back to the corresponding B-item in IMPROVEMENTS.md.
 */

function makeNumericArrayLiteral(n: number): string {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push((i * 37 + 11) & 0xff);
  return `[${xs.join(",")}]`;
}

function makeDispatchSwitch(arms: number): string {
  let s = "function dispatch(op){ switch(op){";
  for (let i = 0; i < arms; i++) {
    s += `case ${i}: return fnTable[${i}](state);`;
  }
  s += "}}";
  return s;
}

describe("B1 — VM bytecode / opcode-dispatch detector", () => {
  it("flags the bytecode + dispatch pair as vm-bytecode", () => {
    const src =
      `var bc = ${makeNumericArrayLiteral(1100)};\n` +
      makeDispatchSwitch(10);
    const r = analyze(src);
    expect(r.summary.vmBytecodeDetected).toBe(true);
    const sf = r.structural.find((s) => s.kind === "vm-bytecode");
    expect(sf).toBeDefined();
    expect(sf!.severity).toBe("high");
    expect((sf!.details as { bytecodeEntries: number }).bytecodeEntries).toBeGreaterThanOrEqual(1024);
    expect((sf!.details as { dispatchSwitchArms: number }).dispatchSwitchArms).toBeGreaterThanOrEqual(8);
  });

  it("does NOT flag a large array without a dispatch switch", () => {
    const r = analyze(`var x = ${makeNumericArrayLiteral(2000)};`);
    expect(r.summary.vmBytecodeDetected).toBe(false);
    expect(r.structural.find((s) => s.kind === "vm-bytecode")).toBeUndefined();
  });

  it("does NOT flag a dispatch switch without bytecode", () => {
    const r = analyze(makeDispatchSwitch(12));
    expect(r.summary.vmBytecodeDetected).toBe(false);
  });

  it("counts String.fromCharCode.apply reconstructions in details", () => {
    const src =
      `var bc = ${makeNumericArrayLiteral(1100)};\n` +
      makeDispatchSwitch(10) +
      `var name = String.fromCharCode.apply(null, [76,79,65,68]);`;
    const r = analyze(src);
    const sf = r.structural.find((s) => s.kind === "vm-bytecode")!;
    expect((sf.details as { fromCharCodeApplyCount: number }).fromCharCodeApplyCount).toBe(1);
  });

  it("does NOT confuse a numeric array of large floats for bytecode", () => {
    const elts = Array(1200).fill(0).map((_, i) => `${1e9 + i}.5`).join(",");
    const r = analyze(`var x = [${elts}];`);
    expect(r.summary.vmBytecodeDetected).toBe(false);
  });
});

describe("B2 — timing-delta + clock-skew probes", () => {
  it("emits timing-delta-probe for `b - a > N` with performance.now() bindings", () => {
    const r = analyze(
      "function check(){ var a = performance.now(); for(var i=0;i<10;i++) {}; var b = performance.now(); if (b - a > 5) corruptSeed(); }",
    );
    const kinds = r.hazards.map((h) => h.kind);
    expect(kinds).toContain("timing-delta-probe");
  });

  it("emits timing-delta-probe with Date.now() bindings", () => {
    const r = analyze(
      "var s = Date.now(); doStuff(); var e = Date.now(); if (e - s > 10) flag();",
    );
    expect(r.hazards.map((h) => h.kind)).toContain("timing-delta-probe");
  });

  it("emits clock-skew-probe for Date.now() - performance.now()", () => {
    const r = analyze("var drift = Date.now() - performance.now();");
    expect(r.hazards.map((h) => h.kind)).toContain("clock-skew-probe");
  });

  it("does NOT flag a single performance.now() read", () => {
    const r = analyze("var x = performance.now(); record(x);");
    expect(r.hazards.map((h) => h.kind)).not.toContain("timing-delta-probe");
    expect(r.hazards.map((h) => h.kind)).not.toContain("clock-skew-probe");
  });

  it("does NOT flag a same-clock subtraction without literal compare", () => {
    const r = analyze("var a = performance.now(); var b = performance.now(); var d = b - a; record(d);");
    expect(r.hazards.map((h) => h.kind)).not.toContain("timing-delta-probe");
  });

  it("counts probes toward antiDebugTells", () => {
    const r = analyze("var a = performance.now(); var b = performance.now(); if (b - a > 5) flag();");
    expect(r.summary.antiDebugTells).toBeGreaterThanOrEqual(1);
  });
});

describe("B3 — UA / feature consistency cross-checks", () => {
  it("emits a consistency-check finding when UA + UA-CH.platform are both read", () => {
    const r = analyze("var u = navigator.userAgent; var p = navigator.userAgentData.platform;");
    const sf = r.structural.find(
      (s) => s.kind === "consistency-check" && s.subkind === "ua-vs-uach-platform",
    );
    expect(sf).toBeDefined();
    expect(sf!.severity).toBe("high");
    expect(r.summary.consistencyChecks).toBeGreaterThanOrEqual(1);
  });

  it("emits geometry-triangulation when screen + DPR are both read", () => {
    const r = analyze("var w = screen.width; var h = screen.height; var d = window.devicePixelRatio;");
    const sf = r.structural.find(
      (s) => s.kind === "consistency-check" && s.subkind === "geometry-triangulation",
    );
    expect(sf).toBeDefined();
  });

  it("does NOT emit a consistency finding when only one member appears", () => {
    const r = analyze("var u = navigator.userAgent;");
    expect(r.structural.find((s) => s.kind === "consistency-check")).toBeUndefined();
    expect(r.summary.consistencyChecks).toBe(0);
  });
});

describe("B4 — CPU-pause / busy-loop probe", () => {
  it("flags an empty for-loop with a large literal bound", () => {
    const r = analyze("for (var i = 0; i < 1000000; i++) {}");
    expect(r.hazards.map((h) => h.kind)).toContain("cpu-pause-probe");
  });

  it("flags via empty-statement body too", () => {
    const r = analyze("for (var i = 0; i < 500000; i++);");
    expect(r.hazards.map((h) => h.kind)).toContain("cpu-pause-probe");
  });

  it("does NOT flag a small-bound loop", () => {
    const r = analyze("for (var i = 0; i < 50; i++) {}");
    expect(r.hazards.map((h) => h.kind)).not.toContain("cpu-pause-probe");
  });

  it("does NOT flag a loop with a real body", () => {
    const r = analyze("for (var i = 0; i < 1000000; i++) { sum += i; }");
    expect(r.hazards.map((h) => h.kind)).not.toContain("cpu-pause-probe");
  });
});

describe("B5 — obfuscated-eval", () => {
  it("flags eval(atob(...))", () => {
    const r = analyze("eval(atob('dmFyIHg9MQ=='));");
    const kinds = r.hazards.map((h) => h.kind);
    expect(kinds).toContain("obfuscated-eval");
    expect(kinds).not.toContain("eval");
  });

  it("flags new Function(String.fromCharCode.apply(null, [...]))", () => {
    const r = analyze("new Function(String.fromCharCode.apply(null, [118,97,114,32,120]));");
    expect(r.hazards.map((h) => h.kind)).toContain("obfuscated-eval");
  });

  it("flags eval(decodeURIComponent(...))", () => {
    const r = analyze("eval(decodeURIComponent('%76%61%72%20%78%3D%31'));");
    expect(r.hazards.map((h) => h.kind)).toContain("obfuscated-eval");
  });

  it("flags Function.prototype.constructor('code')", () => {
    const r = analyze("Function.prototype.constructor('var x=1');");
    expect(r.hazards.map((h) => h.kind)).toContain("obfuscated-eval");
  });

  it("does NOT confuse plain eval(stringLiteral) with obfuscated-eval", () => {
    const r = analyze("eval('1+1');");
    const kinds = r.hazards.map((h) => h.kind);
    expect(kinds).toContain("eval");
    expect(kinds).not.toContain("obfuscated-eval");
  });
});

describe("C1 — Reflect.get trampoline resolution", () => {
  it("synthesizes navigator.userAgent from Reflect.get(navigator, 'userAgent')", () => {
    const r = analyze("var ua = Reflect.get(navigator, 'userAgent');");
    expect(keys(r)).toContain("navigator.userAgent");
  });

  it("works through an aliased target", () => {
    const r = analyze("var n = navigator; var ua = Reflect.get(n, 'userAgent');");
    expect(keys(r)).toContain("navigator.userAgent");
  });

  it("works with a folded fromCharCode property name", () => {
    const r = analyze("var ua = Reflect.get(navigator, String.fromCharCode(117,115,101,114,65,103,101,110,116));");
    expect(keys(r)).toContain("navigator.userAgent");
  });

  it("does not synthesize when the property is dynamic", () => {
    const r = analyze("var ua = Reflect.get(navigator, dynKey);");
    expect(keys(r)).not.toContain("navigator.userAgent");
  });
});

describe("C2 — Object.getOwnPropertyDescriptor(...).get.call trampoline", () => {
  it("synthesizes a *.toDataURL access from the stealth-getter trampoline", () => {
    const r = analyze(
      "var d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toDataURL').get.call(canvas);",
    );
    // The wildcard `*.toDataURL` in the canvas catalog matches the
    // synthesized chain HTMLCanvasElement.prototype.toDataURL.
    expect(keys(r)).toContain("*.toDataURL");
  });

  it("does not synthesize when the key is dynamic", () => {
    const r = analyze(
      "var d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dynKey).get.call(canvas);",
    );
    expect(keys(r)).not.toContain("*.toDataURL");
  });
});

describe("C3 — String.fromCharCode constant folding in computed access", () => {
  it("folds bare String.fromCharCode(...) into the resolved chain", () => {
    // 119,101,98,100,114,105,118,101,114 → "webdriver"
    const r = analyze("var x = navigator[String.fromCharCode(119,101,98,100,114,105,118,101,114)];");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("folds String.fromCharCode.apply(null, [...]) into the resolved chain", () => {
    const r = analyze("var x = navigator[String.fromCharCode.apply(null, [119,101,98,100,114,105,118,101,114])];");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("does not fold when any code is non-literal", () => {
    const r = analyze("var x = navigator[String.fromCharCode(119, c, 98)];");
    expect(keys(r)).not.toContain("navigator.webdriver");
  });
});

describe("C4 — void 0 / undefined classification in payload tracer", () => {
  it("keeps a `{ x: void 0 }` entry in a JSON.stringify payload", () => {
    const r = analyze("fetch('/x', { method: 'POST', body: JSON.stringify({ ua: navigator.userAgent, placeholder: void 0 }) });");
    const sink = r.networkSinks[0];
    expect(sink).toBeDefined();
    const placeholder = sink!.payload?.entries.find((e) => e.key === "placeholder");
    expect(placeholder).toBeDefined();
    expect(placeholder!.literalValue).toBeNull();
  });

  it("keeps a `{ x: undefined }` entry too", () => {
    const r = analyze("fetch('/x', { method: 'POST', body: JSON.stringify({ a: navigator.userAgent, b: undefined }) });");
    const sink = r.networkSinks[0];
    const b = sink!.payload?.entries.find((e) => e.key === "b");
    expect(b).toBeDefined();
    expect(b!.literalValue).toBeNull();
  });
});

describe("C5 — TaggedTemplateExpression in computed access", () => {
  it("resolves String.raw`webdriver` to the navigator.webdriver chain", () => {
    const r = analyze("var x = navigator[String.raw`webdriver`];");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("resolves an identity-tagged template literal too", () => {
    const r = analyze("function id(s){return s.raw[0];} var x = navigator[id`webdriver`];");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("does not resolve a tag with interpolation", () => {
    const r = analyze("var k = 'driver'; var x = navigator[String.raw`web${k}`];");
    expect(keys(r)).not.toContain("navigator.webdriver");
  });
});

describe("A7 — Cognitive-DOM honeypot detector", () => {
  it("flags a fixed-position transparent div with a click listener", () => {
    const src = `
      var el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      el.style.width = '100vw';
      el.addEventListener('click', function(){ flag(); });
    `;
    const r = analyze(src);
    const f = r.structural.find((s) => s.kind === "cognitive-honeypot");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.subkind).toBe("div-honeypot");
  });

  it("flags via onclick = handler too", () => {
    const src = `
      var el = document.createElement('button');
      el.style.position = 'fixed';
      el.style.opacity = '0';
      el.onclick = function(){ trap(); };
    `;
    const r = analyze(src);
    expect(r.structural.find((s) => s.kind === "cognitive-honeypot")).toBeDefined();
  });

  it("flags via setAttribute('style', '...')", () => {
    const src = `
      var el = document.createElement('div');
      el.setAttribute('style', 'position: fixed; opacity: 0; top: 0; left: 0;');
      el.addEventListener('click', t);
    `;
    const r = analyze(src);
    expect(r.structural.find((s) => s.kind === "cognitive-honeypot")).toBeDefined();
  });

  it("does NOT flag a visible button with a click listener", () => {
    const src = `
      var el = document.createElement('button');
      el.style.position = 'relative';
      el.style.opacity = '1';
      el.addEventListener('click', handleClick);
    `;
    const r = analyze(src);
    expect(r.structural.find((s) => s.kind === "cognitive-honeypot")).toBeUndefined();
  });

  it("does NOT flag a transparent overlay without a click listener", () => {
    const src = `
      var el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.opacity = '0';
    `;
    const r = analyze(src);
    expect(r.structural.find((s) => s.kind === "cognitive-honeypot")).toBeUndefined();
  });
});

describe("C7 — verdict line", () => {
  it("classifies a Cloudflare fetch as a Cloudflare Turnstile telemetry", () => {
    const r = analyze("fetch('https://challenges.cloudflare.com/turnstile/v0/api.js');");
    const out = renderText(r, { noColor: true });
    expect(out).toContain("verdict");
    expect(out).toMatch(/Cloudflare Turnstile/);
  });

  it("classifies a bytecode + dispatch script as a VM detector", () => {
    const elts: string[] = [];
    for (let i = 0; i < 1100; i++) elts.push(String((i * 37 + 11) & 0xff));
    let src = `var bc = [${elts.join(",")}];\nfunction d(op){switch(op){`;
    for (let i = 0; i < 10; i++) src += `case ${i}: return t[${i}](s);`;
    src += "}}";
    const r = analyze(src);
    const out = renderText(r, { noColor: true });
    expect(out).toContain("verdict");
    expect(out).toMatch(/Bytecode-VM detector/);
  });

  it("omits the verdict line for a trivial script", () => {
    const r = analyze("var x = 1;");
    const out = renderText(r, { noColor: true });
    expect(out).not.toContain("verdict");
  });
});

describe("E1 — SoK L1–L4 layer field", () => {
  it("tags navigator.userAgent as L1a (static introspection)", () => {
    const r = analyze("var ua = navigator.userAgent;");
    const f = r.findings.find((f) => f.api.key === "navigator.userAgent");
    expect(f?.api.layer).toBe("L1a");
  });

  it("tags console.log as L3 (execution trap)", () => {
    const r = analyze("console.log = trap;");
    const f = r.findings.find((f) => f.api.key === "console.log");
    expect(f?.api.layer).toBe("L3");
  });

  it("tags performance.now as L4 (chronometric)", () => {
    const r = analyze("var t = performance.now();");
    const f = r.findings.find((f) => f.api.key === "performance.now");
    expect(f?.api.layer).toBe("L4");
  });

  it("tags Function.prototype.toString as L2 (obfuscation / source-integrity)", () => {
    const r = analyze("var s = Function.prototype.toString.call(victim);");
    const f = r.findings.find((f) => f.api.key === "Function.prototype.toString");
    expect(f?.api.layer).toBe("L2");
  });

  it("renderText surfaces a layers section when any layer-tagged finding exists", () => {
    // Use a script that produces a tagged finding in any bucket.
    const r = analyze("var ua = navigator.userAgent;");
    const out = renderText(r, { noColor: true });
    expect(out).toContain("layers (SoK)");
    expect(out).toContain("L1a static introspection");
  });
});

describe("A5 — high-res-timer-construction structural finding", () => {
  it("fires when SharedArrayBuffer co-occurs with Atomics.wait/load/store", () => {
    const src = `
      const sab = new SharedArrayBuffer(16);
      const view = new Int32Array(sab);
      const t = Atomics.load(view, 0);
      Atomics.wait(view, 0, t, 1);
    `;
    const r = analyze(src);
    const hit = r.structural.find((s) => s.kind === "high-res-timer-construction");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("high");
    expect(hit!.subkind).toBe("sab-plus-atomics");
    const members = (hit!.details as { members: string[] }).members;
    expect(members).toContain("SharedArrayBuffer");
    expect(members.some((m) => m.startsWith("Atomics."))).toBe(true);
  });

  it("does NOT fire when SharedArrayBuffer alone is used (no Atomics)", () => {
    const r = analyze("const sab = new SharedArrayBuffer(16); console.log(sab.byteLength);");
    const hit = r.structural.find((s) => s.kind === "high-res-timer-construction");
    expect(hit).toBeUndefined();
  });

  it("does NOT fire when Atomics is used without SharedArrayBuffer", () => {
    const r = analyze("Atomics.load(someBuffer, 0);");
    const hit = r.structural.find((s) => s.kind === "high-res-timer-construction");
    expect(hit).toBeUndefined();
  });
});

describe("A3 — favicon-cache persistent-tracking probe detector", () => {
  it("fires when link[rel=icon] href is set + Image ctor + timer read all co-occur", () => {
    const src = `
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = "/fp.ico?id=abc";
      document.head.appendChild(link);
      const t0 = performance.now();
      const img = new Image();
      img.src = "/fp.ico?id=abc";
    `;
    const r = analyze(src);
    const hit = r.structural.find((s) => s.kind === "favicon-cache-probe");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("high");
    expect((hit!.details as { varName: string }).varName).toBe("link");
  });

  it("accepts apple-touch-icon via setAttribute", () => {
    const src = `
      const l = document.createElement("link");
      l.setAttribute("rel", "apple-touch-icon");
      l.href = "/fp.png";
      const t = Date.now();
      const i = new Image();
    `;
    const r = analyze(src);
    const hit = r.structural.find((s) => s.kind === "favicon-cache-probe");
    expect(hit).toBeDefined();
  });

  it("does NOT fire on a plain stylesheet link (rel != icon)", () => {
    const src = `
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/site.css";
      performance.now();
      new Image();
    `;
    const r = analyze(src);
    const hit = r.structural.find((s) => s.kind === "favicon-cache-probe");
    expect(hit).toBeUndefined();
  });

  it("does NOT fire without a timer read", () => {
    const src = `
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = "/fp.ico";
      new Image();
    `;
    const r = analyze(src);
    const hit = r.structural.find((s) => s.kind === "favicon-cache-probe");
    expect(hit).toBeUndefined();
  });

  it("does NOT fire without a new Image() call", () => {
    const src = `
      const link = document.createElement("link");
      link.rel = "icon";
      link.href = "/fp.ico";
      performance.now();
    `;
    const r = analyze(src);
    const hit = r.structural.find((s) => s.kind === "favicon-cache-probe");
    expect(hit).toBeUndefined();
  });
});

describe("Plan B: summary fields are wired", () => {
  it("antiDebugTells aggregates debugger + timing + cpu-pause + obfuscated-eval", () => {
    const r = analyze(
      "debugger; for (var i=0;i<2000000;i++){} var a = performance.now(); var b = performance.now(); if (b-a>5) {} eval(atob('ZA=='));",
    );
    expect(r.summary.antiDebugTells).toBeGreaterThanOrEqual(4);
  });

  it("vmBytecodeDetected flips when bytecode + dispatch coexist", () => {
    const src =
      `var bc = ${makeNumericArrayLiteral(1100)};\n` +
      makeDispatchSwitch(10);
    expect(analyze(src).summary.vmBytecodeDetected).toBe(true);
    expect(analyze("var x = 1;").summary.vmBytecodeDetected).toBe(false);
  });
});
