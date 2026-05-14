---
title: Limits
nav_order: 7
---

# Limits

A static AST pass has hard ceilings. This page is the honest
inventory: what `script2builtins` cannot see, why, and what to
reach for instead.

The companion package
[`script2builtins-runtime`](https://github.com/yourorg/script2builtins-runtime)
closes most of these gaps by trapping the same surfaces in a live
browser — see its [static vs runtime](https://github.com/yourorg/script2builtins-runtime/blob/main/docs/static-vs-runtime.md)
page for the side-by-side coverage table.

## 1. Code that exists only inside an `eval` / `Function` string

```js
const probe = new Function("return navigator.webdriver");
const result = probe();
```

The static pass sees a `Function` hazard. It does **not** see the
`navigator.webdriver` access — that string is just bytes until the
runtime compiles it. Same for `eval("...")`, string-form
`setTimeout("…", ms)`, `setInterval("…", ms)`, and dynamic
`import("...")`.

Mitigation: the hazard is reported so you know to look at the
construction site of the string, and `script2builtins-runtime`
captures the constructed source at runtime and recursively
analyzes it. The runtime's `runtimeOnlyKeys` summary surfaces
exactly the surfaces the static pass missed via this gap.

## 2. Fully dynamic property keys

```js
navigator[obfuscate(0x1a3)];   // returns "userAgent" at runtime
```

`resolveStaticString` returns `null` because `obfuscate(0x1a3)` is
not a static expression. The access is emitted with that segment
as `null` and `hasDynamicSegment: true`, but the matcher won't
resolve it.

What we *do* catch:

- `navigator["userAgent"]` (literal computed key)
- `navigator["user" + "Agent"]` (string concat)
- `` navigator[`userAgent`] `` (template literal, no expressions)
- `var k = "userAgent"; navigator[k]` (string alias)
- `var n = navigator; n.userAgent` (chain alias)

What we don't catch:

- `navigator[atob("dXNlckFnZW50")]`
- `navigator[lookup[0x42]]` (table lookup)
- `navigator[String.fromCharCode(...)]`
- `navigator[obfuscate(0x1a3)]`

These all show up in `unknownAccesses` with a `null` segment if
`includeUnknown` is set. The runtime layer catches all of them at
read time — the Proxy `get` trap on `navigator` fires regardless
of how the key was computed.

## 3. Reflective access through `Reflect.get` and descriptor getters

```js
const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");
desc.get.call(navigator);
```

The static pass sees a `Object.getOwnPropertyDescriptor` access
and a `*.call` access, but it doesn't connect them to
`navigator.userAgent`. Same pattern with `Reflect.get(navigator, "userAgent")`.

The catalog flags both patterns as `botDetectionTell: true`
introspection surfaces (entries on `Reflect.get`,
`Object.getOwnPropertyDescriptor`), so a heavy reliance on these
*does* show up in the report — just not the underlying surface
the script is reading. The runtime layer catches it directly via
its optional `trapReflectGet` mode.

## 4. Anti-debug and runtime byte-pattern checks

```js
const code = navigator.userAgent.toString;
if (!/\[native code\]/.test(code.toString())) throw "instrumented";
```

The static pass sees the chain — but the *check* is a runtime
byte-pattern test that has no analog in static analysis. We catalog
the introspection surfaces (`Function.prototype.toString`,
`eval.toString`, `Error.prepareStackTrace`) so you know the
detector is doing this, but we can't tell you whether the check
passed.

`debugger;` statement traps, integrity checks on prototype chains,
and timing-based detection (`performance.now()` deltas against
expected ranges) all fall in this bucket. They're surfaces, not
results.

## 5. Cross-function data flow

The payload tracer is intra-procedural. It walks variable
bindings and `obj.k = v` mutations within the same scope but
doesn't follow values through function returns:

```js
function wrap(x) { return { ua: x }; }
fetch(url, { body: JSON.stringify(wrap(navigator.userAgent)) });
```

The `fetch` sink is captured. The payload is reported as `json`
shape with an unknown source — the tracer sees `wrap(...)` as a
call expression it doesn't classify. The `navigator.userAgent`
access shows up in `findings` because the walker still extracted
it, but the link between the read and the exfiltration is lost.

Mitigation: read the snippet on the sink. For a definitive
read-to-wire trace, `script2builtins-runtime` captures the bytes
that actually leave the page.

## 6. Reassignment ignored

`buildAliases` and `buildValues` are first-write-wins:

```js
var d = { ua: navigator.userAgent };
d = { fp: getCanvasHash() };          // ignored
fetch(url, { body: JSON.stringify(d) });
```

The body is reported as `ua → navigator.userAgent`. The actual
runtime value is `{ fp: ... }`. The forensic bias is to
over-report — the cost of a false positive is one extra line in
the report; the cost of a false negative is "the detector is
simpler than I thought, what could go wrong."

If this bites in practice (it's never come up on a real detector
because real code doesn't reassign payload-tracking variables),
the fix is to make `buildAliases` / `buildValues` shadow on
reassignment instead of skip. The current behavior is documented
to give consumers room to plan around it.

## 7. Template-literal URL substitution

```js
fetch(`https://collector.example/c?ua=${navigator.userAgent}`);
```

The URL doesn't resolve through `resolveStaticString` because the
template has a non-empty `expressions` array. The sink is still
emitted (with `urlSnippet` set to the source text) but the query
isn't parsed and the substituted access isn't connected.

The `navigator.userAgent` access is still in `findings` from the
walker pass — just not linked to the sink as a `leakedApi`. Fixable;
the work item is "extend `resolveStaticString` to handle
`TemplateLiteral` with expressions by emitting a chain-list
result." Not yet done.

## 8. Array and conditional values in payloads

The tracer classifies object-literal entries, but:

```js
{ ua: cond ? a.b : c.d }     // ConditionalExpression — null
{ fp: [a.b, c.d, e.f] }      // ArrayExpression — null
{ k:  await asyncCall() }    // AwaitExpression — null
```

Each is reported as a snippet-only entry (no `sourceChain`). The
walker still emits the underlying accesses, so the surfaces appear
in `findings`; they just aren't pinned to a sink slot.

## 9. Code we cannot parse

`script2builtins` accepts whatever `acorn` accepts at
`ecmaVersion: "latest"` with the permissive flags. That covers
~99% of the wild — but not:

- Stage-1 / stage-2 proposals.
- Vendor-specific syntax (`#privateGetter` in some older toolchains
  predates the standard).
- Source that requires JSX / TypeScript / Flow parsing.
- Binary blobs (Wasm, base64-encoded JS).

A parse failure returns an empty report with the error in
`report.parse.errors`. The CLI exits 1. Workaround: pre-process
the source through whatever transpiler matches the input (e.g.
`tsc` / `babel`) and feed the JS output through.

## 10. The catalog is finite

Anything not in `ALL_APIS` does not get matched. The catalog is
~460 entries today and grows by a one-line PR; the academic and
practical literature is the gating factor on what gets added. If
your detector probes a surface we haven't catalogued, you'll see
it in `unknownAccesses` (with `--include-unknown`) but it won't
show up in `findings` or contribute to `botDetectionTells`.

The fix is always: add the entry. See [Catalog reference](catalog.html)
for how.

---

## What's *not* a limit, despite looking like one

Some patterns that seem out of reach are actually handled:

- **Aliases of aliases.** `var a = navigator; var b = a; var c = b;
  c.userAgent` resolves all three hops via the two-pass build.
- **Computed keys with operators.** `navigator["user" + "Agent"]`
  resolves. `navigator["user".concat("Agent")]` does not (that's
  the dynamic-key case).
- **`new` with tracked instances.** `new XMLHttpRequest()` /
  `new WebSocket(...)` are tracked across statements so
  `.open(...)` and `.send(body)` are linked.
- **Global stripping across forms.** `window.navigator`,
  `self.navigator`, `globalThis.navigator`, `top.navigator`,
  `parent.navigator`, and `frames.navigator` all collapse to
  `navigator`.
- **Inline-object spread.** `{ ...{ a: navigator.x }, b }` — the
  inner literal's entries are spliced in.
- **`new URLSearchParams("k=v&k=v")`.** String init is parsed.

The single best heuristic for "is this within reach": *if you could
write the same expression with everything literal, the analyzer
will catch it*. The line between "computable from the AST" and
"requires running the program" is exactly the line of what falls
in this page.
