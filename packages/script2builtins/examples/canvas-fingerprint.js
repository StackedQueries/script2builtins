// Canonical canvas fingerprint, plus an audio fingerprint for good measure.
function fingerprint() {
  var canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 50;
  var ctx = canvas.getContext("2d");
  ctx.textBaseline = "top";
  ctx.font = "14px 'Arial'";
  ctx.fillStyle = "#f60";
  ctx.fillRect(125, 1, 62, 20);
  ctx.fillStyle = "#069";
  ctx.fillText("Cwm fjordbank glyphs vext quiz 😃", 2, 15);
  ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
  ctx.fillText("Cwm fjordbank glyphs vext quiz 😃", 4, 17);
  var canvasHash = canvas.toDataURL();

  // WebGL renderer + extension list.
  var gl = canvas.getContext("webgl");
  var dbg = gl.getExtension("WEBGL_debug_renderer_info");
  var renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  var vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
  var exts = gl.getSupportedExtensions();

  // Audio fingerprint via OfflineAudioContext.
  var oc = new OfflineAudioContext(1, 5000, 44100);
  var osc = oc.createOscillator();
  var compressor = oc.createDynamicsCompressor();
  osc.type = "triangle";
  osc.frequency.value = 1e4;
  osc.connect(compressor);
  compressor.connect(oc.destination);
  osc.start(0);
  return oc.startRendering().then(function (buf) {
    return {
      canvasHash: canvasHash,
      renderer: renderer,
      vendor: vendor,
      exts: exts.length,
      audio: buf.getChannelData(0).slice(4500, 5000).reduce(function (a, b) { return a + Math.abs(b); }, 0),
    };
  });
}
