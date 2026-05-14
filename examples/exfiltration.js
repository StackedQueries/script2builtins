// Realistic exfiltration profile: build a fingerprint object, then ship
// it to the detector backend across a few different sinks the way a
// production blob would. Run script2builtins on this file to see every
// surface that gets sent and where.
(function collect() {
  var fp = {
    ua: navigator.userAgent,
    lang: navigator.language,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    wd: navigator.webdriver,
    plg: navigator.plugins.length,
    res: screen.width + "x" + screen.height,
    avail: screen.availWidth + "x" + screen.availHeight,
    color: screen.colorDepth,
    dpr: window.devicePixelRatio,
    vp: window.innerWidth + "x" + window.innerHeight,
    outer: window.outerWidth + "x" + window.outerHeight,
    tz: new Date().getTimezoneOffset(),
    ts: Date.now(),
  };

  // Canvas hash.
  try {
    var c = document.createElement("canvas");
    var ctx = c.getContext("2d");
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillText("👁 Cwm fjordbank glyphs", 2, 15);
    fp.canvas = c.toDataURL();
  } catch (e) { fp.canvas = null; }

  // WebGL renderer.
  try {
    var gl = document.createElement("canvas").getContext("webgl");
    var ext = gl.getExtension("WEBGL_debug_renderer_info");
    fp.gl_vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
    fp.gl_renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch (e) {}

  // Primary exfil — JSON over fetch.
  fetch("https://detector.example/v1/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Site-Id": "site_42" },
    body: JSON.stringify(fp),
  });

  // Backup exfil — sendBeacon survives page unload.
  var fd = new FormData();
  fd.append("ua", navigator.userAgent);
  fd.append("wd", navigator.webdriver);
  fd.append("canvas", fp.canvas);
  navigator.sendBeacon("https://detector.example/v1/beacon", fd);

  // Pixel beacon — works even with strict CSPs that block fetch.
  new Image().src = "https://detector.example/p.gif?wd=" + encodeURIComponent(navigator.webdriver) + "&v=2";

  // Realtime channel for behavioural events.
  var ws = new WebSocket("wss://detector.example/v1/stream");
  ws.send(JSON.stringify({ event: "init", fp: fp }));
})();
