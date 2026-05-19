// Lightly-obfuscated probe — mirrors the bracket-and-concat style used by
// commercial bot-detection vendors. script2builtins follows aliases and
// computed string keys, so the report still names the underlying APIs.
(function () {
  var w = window;
  var n = w["nav" + "igator"];
  var d = w.document;
  var keys = ["webd" + "river", "userAgent", "plug" + "ins", "languages"];

  var report = {};
  for (var i = 0; i < keys.length; i++) {
    report[keys[i]] = n[keys[i]];
  }

  var c = d.createElement("canvas");
  var ctx = c["getContext"]("2d");
  ctx.fillText("verify", 1, 1);
  report.canvas = c.toDataURL();

  // Inline eval-equivalent.
  var probe = new Function("return typeof " + "Buffer" + " !== 'undefined'");
  report.node = probe();

  // String setTimeout — eval-equivalent.
  setTimeout("(0,eval)('1+1')", 0);

  return report;
})();
