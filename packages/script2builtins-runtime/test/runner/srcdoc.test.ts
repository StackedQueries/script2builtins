import { describe, it, expect } from "vitest";
import { extractScriptBodies } from "../../src/runner/driver.js";

describe("extractScriptBodies", () => {
  it("returns inline script bodies from a srcdoc HTML fragment", () => {
    const html = `
      <html>
        <head><title>x</title></head>
        <body>
          <script>const a = navigator.userAgent;</script>
          <script>const b = navigator.webdriver;</script>
        </body>
      </html>`;
    const bodies = extractScriptBodies(html);
    expect(bodies.length).toBe(2);
    expect(bodies[0]).toContain("navigator.userAgent");
    expect(bodies[1]).toContain("navigator.webdriver");
  });

  it("skips <script src=…> tags (those are network-fetched)", () => {
    const html = `<script src="https://cdn.example/foo.js"></script><script>const x = 1;</script>`;
    const bodies = extractScriptBodies(html);
    expect(bodies).toEqual(["const x = 1;"]);
  });

  it("skips JSON / non-JS script types", () => {
    const html = `
      <script type="application/json">{"data": 1}</script>
      <script type="application/ld+json">{"@context": "x"}</script>
      <script type="text/javascript">const ok = 1;</script>
      <script type="module">import './x';</script>
      <script>const bare = 1;</script>`;
    const bodies = extractScriptBodies(html);
    expect(bodies).toContain("const ok = 1;");
    expect(bodies).toContain("import './x';");
    expect(bodies).toContain("const bare = 1;");
    expect(bodies).not.toContain('{"data": 1}');
    expect(bodies).not.toContain('{"@context": "x"}');
  });

  it("handles empty / missing script bodies gracefully", () => {
    expect(extractScriptBodies("")).toEqual([]);
    expect(extractScriptBodies("<script></script>")).toEqual([""]);
    expect(extractScriptBodies("<script>  </script>")).toEqual(["  "]);
  });

  it("handles multi-line and nested-quote script bodies", () => {
    const html = `<script>
      const s = "</";
      const t = '</';
      console.log(s, t);
    </script>`;
    const bodies = extractScriptBodies(html);
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toContain('"</"');
  });
});
