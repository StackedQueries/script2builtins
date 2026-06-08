/**
 * Phase 2B — deobfuscation hardening. Verifies the analyzer sees through
 * the obfuscation real anti-bot challenge scripts ship (string-array
 * tables, JSFuck/arithmetic constant folding, reflective-getter access),
 * AND — critically — that it does NOT emit false matches for tables that
 * are rotated/shuffled at runtime (where static indexing would be wrong).
 */
import { describe, expect, it } from "vitest";
import { analyze } from "../src/index.js";

function keys(r: ReturnType<typeof analyze>): string[] {
  return r.findings.map((f) => f.api.key);
}

describe("string-array table decoding", () => {
  it("resolves obj[_0x[index]] into the underlying property", () => {
    const r = analyze("var _0x=['userAgent','webdriver','plugins']; var v = navigator[_0x[1]];");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("resolves the blog's document[_0x[i]] visibilityState pattern", () => {
    const r = analyze("var _0x=['foo','bar','baz','visibilityState']; var s = document[_0x[3]];");
    expect(keys(r)).toContain("document.visibilityState");
  });

  it("folds a hex index into the table", () => {
    const r = analyze("var _0x=['a','b','webdriver']; var v = navigator[_0x[0x2]];");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("resolves a simple decoder function d(i) => table[i - offset]", () => {
    const r = analyze("var _0x=['userAgent','webdriver']; function d(i){return _0x[i-0x10];} var v = navigator[d(0x11)];");
    expect(keys(r)).toContain("navigator.webdriver");
  });
});

describe("arithmetic / JSFuck constant folding", () => {
  it("folds an arithmetic index expression", () => {
    const r = analyze("var _0x=['a','b','userAgent','d']; var v = navigator[_0x[1+1]];");
    expect(keys(r)).toContain("navigator.userAgent");
  });

  it("folds a JSFuck numeric index (+!+[] === 1)", () => {
    const r = analyze("var _0x=['x','webdriver']; var v = navigator[_0x[+!+[]]];");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("folds a JSFuck string key ([+!+[]]+[+[]] === '10')", () => {
    // table index 10 → 'webdriver'
    const tbl = Array.from({ length: 11 }, (_, i) => (i === 10 ? "'webdriver'" : `'k${i}'`)).join(",");
    const r = analyze(`var _0x=[${tbl}]; var v = navigator[_0x[[+!+[]]+[+[]]]];`);
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("still resolves String.fromCharCode keys", () => {
    const r = analyze("var v = navigator[String.fromCharCode(119,101,98,100,114,105,118,101,114)];");
    expect(keys(r)).toContain("navigator.webdriver");
  });
});

describe("escape decoding (handled by the parser)", () => {
  it("resolves hex-escaped property keys", () => {
    const r = analyze("var v = navigator['\\x77\\x65\\x62\\x64\\x72\\x69\\x76\\x65\\x72'];");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("resolves unicode-escaped property keys", () => {
    const r = analyze("var v = navigator['\\u0077\\u0065\\u0062\\u0064\\u0072\\u0069\\u0076\\u0065\\u0072'];");
    expect(keys(r)).toContain("navigator.webdriver");
  });
});

describe("reflective-getter access maps to the underlying key", () => {
  it("Reflect.get(navigator, 'webdriver')", () => {
    const r = analyze("var v = Reflect.get(navigator, 'webdriver');");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("navigator.__lookupGetter__('webdriver').call(navigator)", () => {
    const r = analyze("var v = navigator.__lookupGetter__('webdriver').call(navigator);");
    expect(keys(r)).toContain("navigator.webdriver");
  });

  it("Object.getOwnPropertyDescriptor(navigator,'webdriver').get.call(navigator) (inline)", () => {
    const r = analyze("var v = Object.getOwnPropertyDescriptor(navigator,'webdriver').get.call(navigator);");
    expect(keys(r)).toContain("navigator.webdriver");
  });
});

describe("rotation safety — no false matches on shuffled tables", () => {
  it("does NOT statically index a table mutated by a rotate IIFE", () => {
    // After one push(shift()), _0x[1] is 'userAgent', not 'webdriver'.
    // Static analysis cannot know the rotated order, so it must emit neither
    // (a wrong 'navigator.webdriver' match would be worse than a miss).
    const r = analyze("var _0x=['userAgent','webdriver']; (function(a){a.push(a.shift());})(_0x); var v = navigator[_0x[1]];");
    expect(keys(r)).not.toContain("navigator.webdriver");
  });

  it("does NOT index a table directly mutated by push/shift", () => {
    const r = analyze("var _0x=['userAgent','webdriver']; _0x.push(_0x.shift()); var v = navigator[_0x[1]];");
    expect(keys(r)).not.toContain("navigator.webdriver");
  });
});
