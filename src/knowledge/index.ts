import type { ApiDefinition } from "../types.js";
import { navigatorApis } from "./navigator.js";
import { windowScreenApis } from "./window-screen.js";
import { documentApis } from "./document.js";
import { canvasApis } from "./canvas.js";
import { webglApis } from "./webgl.js";
import { audioApis } from "./audio.js";
import { webrtcApis } from "./webrtc.js";
import { timingApis } from "./timing.js";
import { intlApis } from "./intl.js";
import { headlessTellApis } from "./headless-tells.js";
import { introspectionApis } from "./introspection.js";
import { storageFontsApis } from "./storage-fonts.js";
import { sensorApis } from "./sensors.js";
import { mediaPermissionsApis } from "./media-permissions.js";
import { mediaCapabilitiesApis } from "./media-capabilities.js";
import { eventsDomApis } from "./events-dom.js";
import { speechApis } from "./speech.js";
import { mathApis } from "./math.js";
import { cssStyleApis } from "./css-style.js";
import { svgApis } from "./svg.js";
import { workerApis } from "./workers.js";
import { wasmApis } from "./wasm.js";

export const ALL_APIS: ApiDefinition[] = [
  ...navigatorApis,
  ...windowScreenApis,
  ...documentApis,
  ...canvasApis,
  ...webglApis,
  ...audioApis,
  ...webrtcApis,
  ...timingApis,
  ...intlApis,
  ...headlessTellApis,
  ...introspectionApis,
  ...storageFontsApis,
  ...sensorApis,
  ...mediaPermissionsApis,
  ...mediaCapabilitiesApis,
  ...eventsDomApis,
  ...speechApis,
  ...mathApis,
  ...cssStyleApis,
  ...svgApis,
  ...workerApis,
  ...wasmApis,
];

export {
  navigatorApis,
  windowScreenApis,
  documentApis,
  canvasApis,
  webglApis,
  audioApis,
  webrtcApis,
  timingApis,
  intlApis,
  headlessTellApis,
  introspectionApis,
  storageFontsApis,
  sensorApis,
  mediaPermissionsApis,
  mediaCapabilitiesApis,
  eventsDomApis,
  speechApis,
  mathApis,
  cssStyleApis,
  svgApis,
  workerApis,
  wasmApis,
};

/** Set of leftmost segments across all non-wildcard API keys, plus hazard sinks. */
export function watchedRoots(apis: ApiDefinition[] = ALL_APIS): Set<string> {
  const roots = new Set<string>([
    // Hazard / sink call targets
    "eval",
    "Function",
    "setTimeout",
    "setInterval",
    // Always-watched globals because their identifier can stand alone
    "navigator",
    "document",
    "window",
    "screen",
    "location",
    "history",
    "performance",
    "chrome",
    "Notification",
    "Intl",
    "Reflect",
    "Proxy",
    "Symbol",
    "Object",
    "Date",
    "Error",
    "crypto",
    "Math",
    "Atomics",
    "WebAssembly",
    "SharedArrayBuffer",
    "Worker",
    "SharedWorker",
    "ServiceWorker",
    "OffscreenCanvas",
    "AudioContext",
    "OfflineAudioContext",
    "webkitAudioContext",
    "AudioWorklet",
    "AudioWorkletNode",
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "mozRTCPeerConnection",
    "RTCRtpSender",
    "RTCRtpReceiver",
    "RTCRtpTransceiver",
    "RTCSessionDescription",
    "RTCIceCandidate",
    "speechSynthesis",
    "SpeechSynthesisVoice",
    "SpeechSynthesisUtterance",
    "FontFace",
    "FontFaceSet",
    "CSS",
    "CSSStyleSheet",
    "CookieStore",
    "cookieStore",
    "caches",
    "crossOriginIsolated",
    "indexedDB",
    "openDatabase",
    "localStorage",
    "sessionStorage",
    "MediaSource",
    "MediaRecorder",
    "MediaCapabilities",
    "requestAnimationFrame",
    "matchMedia",
    "getComputedStyle",
    "showOpenFilePicker",
    "showDirectoryPicker",
    "showSaveFilePicker",
    "ScreenDetailed",
    "MutationObserver",
    "IntersectionObserver",
    "ResizeObserver",
    "PerformanceObserver",
    "ReportingObserver",
    "DeviceMotionEvent",
    "DeviceOrientationEvent",
    "TouchEvent",
    "PointerEvent",
    "Gyroscope",
    "Accelerometer",
    "Magnetometer",
    "AmbientLightSensor",
    "LinearAccelerationSensor",
    "GravitySensor",
    "AbsoluteOrientationSensor",
    "RelativeOrientationSensor",
    "Sensor",
    "Blob",
    "URL",
    "WorkerNavigator",
  ]);
  for (const api of apis) {
    const parts = api.key.split(".");
    const head = parts[0];
    if (head && head !== "*") roots.add(head);
  }
  return roots;
}
