import { describe, expect, it } from "vitest";
import { analyze } from "../src/index.js";

function keys(report: ReturnType<typeof analyze>): string[] {
  return report.findings.map((f) => f.api.key);
}

function findHit(report: ReturnType<typeof analyze>, key: string) {
  return report.findings.find((f) => f.api.key === key);
}

describe("analyze: parse handling", () => {
  it("returns parse failure metadata on broken source", () => {
    const r = analyze("var x = ;");
    expect(r.parse.ok).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("parses module-level await without complaint", () => {
    const r = analyze("await fetch('/');");
    expect(r.parse.ok).toBe(true);
  });

  it("parses bare scripts", () => {
    const r = analyze("var x = 1;");
    expect(r.parse.ok).toBe(true);
  });
});

describe("analyze: navigator surface", () => {
  it("detects navigator.webdriver as a high-severity tell", () => {
    const r = analyze("if (navigator.webdriver) throw 1;");
    const hit = findHit(r, "navigator.webdriver");
    expect(hit).toBeDefined();
    expect(hit!.api.severity).toBe("high");
    expect(hit!.api.botDetectionTell).toBe(true);
    expect(r.summary.botDetectionTells).toBeGreaterThan(0);
  });

  it("detects navigator.userAgent via bracket notation with string literal", () => {
    const r = analyze('var ua = navigator["userAgent"];');
    expect(keys(r)).toContain("navigator.userAgent");
  });

  it("detects navigator.userAgent via string concat in computed key", () => {
    const r = analyze('var ua = navigator["user" + "Agent"];');
    expect(keys(r)).toContain("navigator.userAgent");
  });

  it("resolves aliased globals (`var n = navigator; n.webdriver`)", () => {
    const r = analyze("var n = navigator; var w = n.webdriver;");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("resolves multi-hop aliases", () => {
    const r = analyze("var n = navigator; var p = n.plugins; p.length;");
    expect(keys(r)).toContain("navigator.plugins");
  });

  it("resolves string aliases used as computed keys", () => {
    const r = analyze('var k = "userAgent"; var ua = navigator[k];');
    expect(keys(r)).toContain("navigator.userAgent");
  });

  it("strips window/self/globalThis prefixes", () => {
    for (const root of ["window", "self", "globalThis", "top", "parent"]) {
      const r = analyze(`var x = ${root}.navigator.webdriver;`);
      expect(keys(r)).toContain("navigator.webdriver");
    }
  });
});

describe("analyze: canvas + getContext arg matching", () => {
  it("matches *.getContext only when first arg is '2d'", () => {
    const r2d = analyze('var c = document.createElement("canvas").getContext("2d");');
    const find = r2d.findings.find((f) => f.api.key === "*.getContext" && f.api.argMatch?.includes("2d"));
    expect(find).toBeDefined();
  });

  it("matches the WebGL bucket of *.getContext for 'webgl'", () => {
    const r = analyze('var c = canvas.getContext("webgl");');
    const find = r.findings.find((f) => f.api.key === "*.getContext" && f.api.argMatch?.includes("webgl"));
    expect(find).toBeDefined();
    expect(find!.api.category).toBe("webgl");
  });

  it("flags toDataURL, fillText, getImageData regardless of receiver", () => {
    const r = analyze("var d = whatever.toDataURL(); something.fillText('x',0,0); foo.getImageData(0,0,1,1);");
    expect(keys(r)).toEqual(expect.arrayContaining(["*.toDataURL", "*.fillText", "*.getImageData"]));
  });
});

describe("analyze: hazards", () => {
  it("flags eval", () => {
    const r = analyze("eval('1+1');");
    expect(r.hazards.map((h) => h.kind)).toContain("eval");
  });

  it("flags Function constructor (call form)", () => {
    const r = analyze('Function("return 1")();');
    expect(r.hazards.map((h) => h.kind)).toContain("Function");
  });

  it("flags `new Function`", () => {
    const r = analyze('new Function("return 1");');
    expect(r.hazards.map((h) => h.kind)).toContain("Function");
  });

  it("flags setTimeout with a string arg, ignores function arg", () => {
    const rs = analyze('setTimeout("alert(1)", 100);');
    const rf = analyze("setTimeout(function(){}, 100);");
    expect(rs.hazards.map((h) => h.kind)).toContain("setTimeout-string");
    expect(rf.hazards.map((h) => h.kind)).not.toContain("setTimeout-string");
  });

  it("flags with-statements", () => {
    // `with` only legal in non-strict; force script parse.
    const r = analyze("with (navigator) { var x = userAgent; }", { sourceType: "script" });
    expect(r.hazards.map((h) => h.kind)).toContain("with-statement");
  });

  it("flags document.write", () => {
    const r = analyze('document.write("<script>");');
    expect(r.hazards.map((h) => h.kind)).toContain("document-write");
  });

  it("flags dynamic import()", () => {
    const r = analyze('import("./fp.js");');
    expect(r.hazards.map((h) => h.kind)).toContain("import-call");
  });
});

describe("analyze: introspection + headless tells", () => {
  it("flags Function.prototype.toString", () => {
    const r = analyze("Function.prototype.toString.call(navigator.webdriver);");
    expect(keys(r)).toContain("Function.prototype.toString");
  });

  it("flags ChromeDriver $cdc_ marker", () => {
    const r = analyze("if (window.$cdc_asdjflasutopfhvcZLmcfl_) report();");
    expect(keys(r)).toContain("$cdc_asdjflasutopfhvcZLmcfl_");
  });

  it("flags Object.getOwnPropertyDescriptor", () => {
    const r = analyze("Object.getOwnPropertyDescriptor(navigator, 'webdriver');");
    expect(keys(r)).toContain("Object.getOwnPropertyDescriptor");
  });
});

describe("analyze: WebGL unmasked-renderer trick", () => {
  it("matches the *.getExtension WEBGL_debug_renderer_info specialization", () => {
    const r = analyze('var ext = gl.getExtension("WEBGL_debug_renderer_info");');
    const specific = r.findings.find(
      (f) => f.api.key === "*.getExtension" && f.api.argMatch?.includes("WEBGL_debug_renderer_info"),
    );
    expect(specific).toBeDefined();
    expect(specific!.api.severity).toBe("high");
  });
});

describe("analyze: ignores binding/property positions", () => {
  it("does not emit accesses for parameter or property-key uses of watched names", () => {
    const r = analyze(`
      function navigator(window) { return { document: 1 }; }
      var o = { navigator: 1, document: 2 };
    `);
    // No findings because all uses of these names are bindings or non-shorthand keys.
    expect(r.findings).toEqual([]);
  });

  it("emits for shorthand property values", () => {
    // Shorthand `{ navigator }` is a real reference to the navigator global.
    // The catalog has no entry for the bare root, so this shows in unknownAccesses.
    const r = analyze("var o = { navigator };", { includeUnknown: true });
    const seen = r.unknownAccesses.some((a) => a.chain.length === 1 && a.chain[0] === "navigator");
    expect(seen).toBe(true);
  });
});

describe("analyze: report shape + summary", () => {
  it("computes density and per-category grouping", () => {
    const r = analyze(`
      navigator.webdriver;
      navigator.userAgent;
      var c = canvas.toDataURL();
    `);
    expect(r.summary.knownAccesses).toBeGreaterThanOrEqual(3);
    expect(r.summary.fingerprintingDensityPerKb).toBeGreaterThan(0);
    expect(r.byCategory.navigator?.length ?? 0).toBeGreaterThan(0);
    expect(r.byCategory.canvas?.length ?? 0).toBeGreaterThan(0);
  });

  it("sorts findings by severity (high first)", () => {
    const r = analyze("navigator.webdriver; navigator.cookieEnabled;");
    const sevs = r.findings.map((f) => f.api.severity);
    const high = sevs.indexOf("high");
    const info = sevs.indexOf("info");
    if (high !== -1 && info !== -1) expect(high).toBeLessThan(info);
  });
});
