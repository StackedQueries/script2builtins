import type { ApiDefinition } from "../types.js";

/**
 * MediaCapabilities + the MediaSource / MediaRecorder static probes.
 * Codec-support tables vary substantially across OS+browser+GPU combos
 * (HEVC/Dolby Vision on macOS, AV1 hardware decode availability, etc.)
 * and are checked via three sibling APIs.
 */
export const mediaCapabilitiesApis: ApiDefinition[] = [
  {
    key: "MediaCapabilities",
    category: "media-capabilities",
    severity: "medium",
    description: "navigator.mediaCapabilities root.",
  },
  {
    key: "*.decodingInfo",
    category: "media-capabilities",
    severity: "high",
    botDetectionTell: true,
    description: "navigator.mediaCapabilities.decodingInfo({...}). Returns {supported, smooth, powerEfficient} per codec/resolution. powerEfficient is a strong hardware-decode-availability fingerprint.",
  },
  {
    key: "*.encodingInfo",
    category: "media-capabilities",
    severity: "medium",
    description: "navigator.mediaCapabilities.encodingInfo({...}). Hardware-encode capability surface.",
  },
  {
    key: "MediaSource",
    category: "media-capabilities",
    severity: "low",
    description: "MediaSource constructor / static methods. .isTypeSupported is in media-permissions; the constructor presence itself is a capability probe.",
  },
  {
    key: "MediaSource.isTypeSupported",
    category: "media-capabilities",
    severity: "high",
    botDetectionTell: true,
    description: "Static codec probe — independent of an instance. Detectors enumerate ~30 codec strings (vp9, av01, hvc1, hev1, mp4a.40.x, opus, ec-3) for OS-fingerprint.",
  },
  {
    key: "MediaRecorder.isTypeSupported",
    category: "media-capabilities",
    severity: "medium",
    description: "Static codec probe for recording. Smaller variation than MediaSource but still a fingerprint axis.",
  },
];
