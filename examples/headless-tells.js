// Distilled "is this a bot?" probe of the kind seen in the wild.
// Pipe this file through `script2builtins` to see every detection axis named.
(function detect() {
  // Cheap, deterministic tells.
  if (navigator.webdriver) return "automation";
  if (window.callPhantom || window._phantom) return "phantom";
  if (window.__nightmare) return "nightmare";
  if (window.domAutomation || window.domAutomationController) return "auto-flag";
  for (var k in window) {
    if (k.indexOf("$cdc_") === 0 || k.indexOf("__webdriver_") === 0) return "selenium";
  }

  // Inconsistency tells.
  if (navigator.languages && navigator.languages.length === 0) return "headless-langs";
  if (navigator.plugins && navigator.plugins.length === 0) return "headless-plugins";
  if (window.outerWidth === 0 || window.outerHeight === 0) return "headless-viewport";

  // The Notification.permission / permissions.query mismatch.
  if (window.Notification && navigator.permissions) {
    return navigator.permissions.query({ name: "notifications" }).then(function (p) {
      if (Notification.permission === "denied" && p.state === "prompt") return "headless-permissions";
      return "human";
    });
  }
  return "human";
})();
