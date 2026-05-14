import type { ApiDefinition } from "../types.js";

export const mediaPermissionsApis: ApiDefinition[] = [
  {
    key: "*.enumerateDevices",
    category: "media",
    severity: "high",
    botDetectionTell: true,
    description: "navigator.mediaDevices.enumerateDevices(). Returns device entries (kind, deviceId, groupId, label). Empty array or default-only labels signal headless.",
    evasion: "Spoof a plausible device set (default audioinput, default audiooutput, default videoinput) with stable groupIds.",
  },
  {
    key: "*.getUserMedia",
    category: "media",
    severity: "low",
    description: "Capability check; rarely actually invoked by detectors.",
  },
  {
    key: "*.canPlayType",
    category: "media",
    severity: "medium",
    description: "HTMLMediaElement.canPlayType. Returns 'probably' / 'maybe' / '' across codecs — codec-support fingerprint.",
  },
  {
    key: "*.isTypeSupported",
    category: "media",
    severity: "medium",
    description: "MediaRecorder/MediaSource.isTypeSupported. Codec-support fingerprint axis.",
  },
  {
    key: "*.query",
    category: "media",
    argMatch: ["clipboard-read", "clipboard-write", "geolocation", "notifications", "camera", "microphone", "midi", "background-sync", "ambient-light-sensor", "accelerometer", "gyroscope", "magnetometer", "persistent-storage"],
    severity: "high",
    botDetectionTell: true,
    description: "navigator.permissions.query({name:...}). When name is 'notifications', the result is the canonical Chrome-headless detector (Notification.permission='denied' but state='prompt' on headless).",
  },
  {
    key: "Notification.permission",
    category: "media",
    severity: "medium",
    description: "Notification permission state ('default'/'granted'/'denied'). Combined with permissions.query for the headless tell.",
    botDetectionTell: true,
  },
  {
    key: "crypto.getRandomValues",
    category: "media",
    severity: "info",
    description: "CSPRNG; ubiquitous — appears in plenty of legitimate code.",
  },
  {
    key: "crypto.subtle",
    category: "media",
    severity: "info",
    description: "WebCrypto subtle interface; rarely fingerprinted.",
  },
  {
    key: "crypto.randomUUID",
    category: "media",
    severity: "info",
    description: "Capability check; presence on a UA claiming an old browser is a tell.",
  },
];
