import type { ApiDefinition, SokLayer } from "./types.js";
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
import { consoleApis } from "./console.js";
import { extensionsApis } from "./extensions.js";

/**
 * Default SoK layer (Abel 2024) per catalog category. The renderer's
 * `L1a–L4` bucketed summary uses this to backfill the optional
 * `ApiDefinition.layer` field — individual entries that need to
 * override the category default can set `layer` explicitly.
 *
 * Categories without a sensible default (e.g., "navigator" — mostly
 * L1a but with B1 / behavior-adjacent outliers) are omitted; their
 * entries get no layer unless explicitly tagged.
 */
const CATEGORY_DEFAULT_LAYER: Record<string, SokLayer> = {
  // L1a — static environmental introspection
  navigator: "L1a",
  window: "L1a",
  screen: "L1a",
  canvas: "L1a",
  webgl: "L1a",
  audio: "L1a",
  webrtc: "L1a",
  intl: "L1a",
  speech: "L1a",
  math: "L1a",
  css: "L1a",
  svg: "L1a",
  fonts: "L1a",
  media: "L1a",
  "media-capabilities": "L1a",
  storage: "L1a",
  document: "L1a",
  extensions: "L1a",
  // L1b — behavioral biometrics
  events: "L1b",
  "dom-layout": "L1b",
  sensors: "L1b",
  // L2 — obfuscation / source-integrity
  introspection: "L2",
  // L3 — execution traps
  "anti-debug": "L3",
  "headless-tells": "L3",
  // L4 — chronometric integrity
  timing: "L4",
  wasm: "L4",
  workers: "L1a",
};

function withDefaultLayer(apis: ApiDefinition[]): ApiDefinition[] {
  return apis.map((api) => {
    if (api.layer) return api;
    const dflt = CATEGORY_DEFAULT_LAYER[api.category];
    return dflt ? { ...api, layer: dflt } : api;
  });
}

export const ALL_APIS: ApiDefinition[] = [
  ...withDefaultLayer(navigatorApis),
  ...withDefaultLayer(windowScreenApis),
  ...withDefaultLayer(documentApis),
  ...withDefaultLayer(canvasApis),
  ...withDefaultLayer(webglApis),
  ...withDefaultLayer(audioApis),
  ...withDefaultLayer(webrtcApis),
  ...withDefaultLayer(timingApis),
  ...withDefaultLayer(intlApis),
  ...withDefaultLayer(headlessTellApis),
  ...withDefaultLayer(introspectionApis),
  ...withDefaultLayer(storageFontsApis),
  ...withDefaultLayer(sensorApis),
  ...withDefaultLayer(mediaPermissionsApis),
  ...withDefaultLayer(mediaCapabilitiesApis),
  ...withDefaultLayer(eventsDomApis),
  ...withDefaultLayer(speechApis),
  ...withDefaultLayer(mathApis),
  ...withDefaultLayer(cssStyleApis),
  ...withDefaultLayer(svgApis),
  ...withDefaultLayer(workerApis),
  ...withDefaultLayer(wasmApis),
  ...withDefaultLayer(consoleApis),
  ...withDefaultLayer(extensionsApis),
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
  consoleApis,
  extensionsApis,
};
export {
  knownEndpoints,
  classifyEndpointUrl,
  classifyEndpointPayloadKeys,
  type KnownEndpoint,
} from "./endpoints.js";

export type { Severity, SokLayer, ApiDefinition } from "./types.js";

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
