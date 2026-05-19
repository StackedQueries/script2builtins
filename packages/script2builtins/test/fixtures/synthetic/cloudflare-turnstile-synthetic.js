// Synthetic Cloudflare Turnstile / challenge-platform telemetry.
// Exercises:
//
//   - Cloudflare Turnstile endpoint (challenges.cloudflare.com)
//   - cdn-cgi/challenge-platform endpoint
//   - Canvas + audio fingerprint reads
//   - Webdriver / plugins / permissions tells
//   - Behavioral biometrics (mousemove + isTrusted)

(function () {
  var fp = {};

  // Static introspection.
  fp.ua = navigator.userAgent;
  fp.wd = navigator.webdriver;
  fp.plug = navigator.plugins.length;
  fp.lang = navigator.languages;
  fp.hc = navigator.hardwareConcurrency;

  // Canvas fp.
  var c = document.createElement("canvas");
  var x = c.getContext("2d");
  x.fillText("cf", 0, 0);
  fp.cnv = c.toDataURL();

  // Audio fp.
  var ac = new OfflineAudioContext(1, 256, 44100);
  ac.createDynamicsCompressor();
  ac.createOscillator();
  ac.startRendering();

  // Behavioral biometrics.
  var trusted = 0;
  document.addEventListener("mousemove", function (e) {
    if (e.isTrusted) trusted++;
    var dx = e.movementX;
    var dy = e.movementY;
    dx + dy;
  });

  // Cloudflare challenge endpoints.
  fetch("https://challenges.cloudflare.com/turnstile/v0/api.js?onload=tcb", {
    method: "GET",
  });

  fetch("/cdn-cgi/challenge-platform/h/g/scripts/jsd/abc123/main.js", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p: fp, t: trusted, ts: Date.now() }),
  });
})();
