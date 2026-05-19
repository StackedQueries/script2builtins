// A miniature fingerprint detector — useful for testing the runtime.
// Run it with:
//   s2b examples/example.js               # static
//   s2b examples/example.js --dynamic     # harness + traps
(function () {
  const ua = navigator.userAgent;
  const wd = navigator.webdriver;
  const cores = navigator.hardwareConcurrency;
  const mem = navigator.deviceMemory;
  const langs = navigator.languages;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.fillText("script2builtins", 2, 2);
  const fp = canvas.toDataURL();

  const payload = JSON.stringify({ ua, wd, cores, mem, langs, fp });
  fetch("https://example.com/collect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  }).catch(() => {});
})();
