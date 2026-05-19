// Synthetic DataDome-class telemetry blob. Exercises:
//
//   - Canvas + WebGL fingerprint reads
//   - Audio fingerprint (OfflineAudioContext)
//   - UA-vs-UA-CH consistency cross-check (B3)
//   - DataDome endpoint (js.datadome.co)
//   - sensor_data payload field name (DataDome marker)

(function () {
  // Canvas fingerprint.
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d");
  ctx.fillText("BrowserLeaks", 2, 2);
  var canvasFp = canvas.toDataURL("image/png");

  // WebGL fingerprint.
  var glCanvas = document.createElement("canvas");
  var gl = glCanvas.getContext("webgl");
  var ext = gl.getExtension("WEBGL_debug_renderer_info");
  var renderer = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : 7937);
  var vendor = gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : 7936);

  // Audio fingerprint.
  var ac = new OfflineAudioContext(1, 1000, 44100);
  var comp = ac.createDynamicsCompressor();
  comp.connect(ac.destination);
  var osc = ac.createOscillator();
  osc.connect(comp);
  osc.start();
  ac.startRendering().then(function (buf) {
    var data = buf.getChannelData(0);
    return Array.prototype.slice.call(data, 0, 50);
  });

  // UA vs UA-CH consistency cross-check.
  var ua = navigator.userAgent;
  var uacPlatform = navigator.userAgentData.platform;
  var platform = navigator.platform;

  var sensor_data = {
    ua: navigator.userAgent,
    uac: navigator.userAgentData.platform,
    plat: navigator.platform,
    cnv: canvasFp,
    gpu: renderer,
    wd: navigator.webdriver,
    hc: navigator.hardwareConcurrency,
    mem: navigator.deviceMemory,
    lang: navigator.languages,
    plug: navigator.plugins.length,
  };

  // DataDome telemetry endpoint. URL is intentionally static so the
  // analyzer's URL resolver pins it to the provider table.
  fetch("https://js.datadome.co/js/abc123", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sensor_data: sensor_data,
      ua: navigator.userAgent,
      wd: navigator.webdriver,
      plat: navigator.platform,
      lang: navigator.languages,
      hc: navigator.hardwareConcurrency,
    }),
  });

  // Touch unused locals so static-analysis fixtures don't complain.
  ua; uacPlatform; platform; vendor;
})();
