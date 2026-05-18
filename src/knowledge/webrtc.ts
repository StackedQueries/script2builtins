import type { ApiDefinition } from "../types.js";

export const webrtcApis: ApiDefinition[] = [
  {
    key: "RTCPeerConnection",
    category: "webrtc",
    severity: "high",
    botDetectionTell: true,
    description: "WebRTC entry point. Used both for STUN-based local-IP leaks and to fingerprint the codec list (SDP).",
    evasion: "Either disable WebRTC at the browser level (--disable-features=WebRtc, or about:config in Firefox) or override createOffer/createAnswer to strip ICE candidates. Detectors notice when RTCPeerConnection exists but produces no candidates.",
  },
  {
    key: "webkitRTCPeerConnection",
    category: "webrtc",
    severity: "high",
    botDetectionTell: true,
    description: "Legacy prefixed WebRTC.",
  },
  {
    key: "mozRTCPeerConnection",
    category: "webrtc",
    severity: "medium",
    description: "Firefox-prefixed legacy WebRTC.",
  },
  {
    key: "*.createDataChannel",
    category: "webrtc",
    severity: "medium",
    description: "Cheap way to force ICE candidate gathering without needing media permissions.",
  },
  {
    key: "*.createOffer",
    category: "webrtc",
    severity: "medium",
    description: "Initiates SDP offer; SDP body contains codec/extension fingerprint material.",
  },
  {
    key: "*.setLocalDescription",
    category: "webrtc",
    severity: "medium",
    description: "Triggers ICE gathering — the step that surfaces local IP candidates.",
  },
  {
    key: "RTCSessionDescription",
    category: "webrtc",
    severity: "low",
    description: "SDP wrapper; rarely the focus on its own.",
  },
  {
    key: "RTCIceCandidate",
    category: "webrtc",
    severity: "medium",
    description: "Candidate parsing; presence near a regex over `candidate:` lines indicates IP leak harvesting.",
  },
  {
    key: "*.createAnswer",
    category: "webrtc",
    severity: "medium",
    description: "RTCPeerConnection.createAnswer. SDP answer body contains codec/extension fingerprint material.",
  },
  {
    key: "*.setRemoteDescription",
    category: "webrtc",
    severity: "low",
    description: "Counterpart to setLocalDescription; rarely the fingerprint target on its own.",
  },
  {
    key: "RTCRtpSender",
    category: "webrtc",
    severity: "high",
    botDetectionTell: true,
    description: "RTCRtpSender.getCapabilities('video'/'audio') returns codecs/headerExtensions/fec without ever instantiating a connection — a fast, low-noise codec-fingerprint surface that bypasses SDP harvesting.",
    evasion: "Override RTCRtpSender.getCapabilities as a static method on the constructor; keep the returned shape (codecs[], headerExtensions[]) intact.",
  },
  {
    key: "RTCRtpReceiver",
    category: "webrtc",
    severity: "high",
    botDetectionTell: true,
    description: "Sibling of RTCRtpSender.getCapabilities; same codec/extension fingerprint axis from the receive side.",
  },
  {
    key: "RTCRtpTransceiver",
    category: "webrtc",
    severity: "low",
    description: "Capability probe — presence pins WebRTC unified-plan support.",
  },
  {
    key: "*.getCapabilities",
    category: "webrtc",
    severity: "high",
    botDetectionTell: true,
    description: "Aliased static-capability probe (var s = RTCRtpSender; s.getCapabilities('video')).",
  },

  // ─── IP-leak & stats surfaces (2020 - Neither Denied nor Exposed Fixing WebRTC) ───
  // The IP-leak vector is: create RTCPeerConnection → install
  // onicecandidate handler → call createOffer + setLocalDescription →
  // the handler fires with `event.candidate.candidate`, a string
  // containing the local IP. Detect every step.
  {
    key: "*.onicecandidate",
    category: "webrtc",
    severity: "high",
    botDetectionTell: true,
    description: "RTCPeerConnection.onicecandidate handler. THE IP-leak hook: the callback receives ICE candidates including local IP addresses parseable from the SDP candidate line. Read or assignment both worth flagging.",
    evasion: "Block locally by overriding RTCPeerConnection.prototype.setLocalDescription to never gather host candidates, or use mDNS-only mode (default in modern Chrome — but desktop detectors specifically look for the absence of host candidates as a tell).",
  },
  {
    key: "*.addIceCandidate",
    category: "webrtc",
    severity: "medium",
    description: "RTCPeerConnection.addIceCandidate. Less common as a leak vector, but appears in symmetric setups that round-trip candidates.",
  },
  {
    key: "*.localDescription",
    category: "webrtc",
    severity: "high",
    botDetectionTell: true,
    description: "RTCPeerConnection.localDescription. SDP body containing every gathered ICE candidate (including local-IP host candidates). Reading the .sdp string and regex-scanning for `candidate:` lines is the standard IP-leak harvest.",
  },
  {
    key: "*.candidate",
    category: "webrtc",
    severity: "medium",
    description: "RTCIceCandidate.candidate. The raw SDP candidate line — contains the local IP. Reading this near a regex over /^candidate:/ is the IP-extraction signature.",
    botDetectionTell: true,
  },
  {
    key: "*.iceGatheringState",
    category: "webrtc",
    severity: "low",
    description: "RTCPeerConnection.iceGatheringState ('new' | 'gathering' | 'complete'). Polled during IP-leak harvesting to know when to read localDescription.",
  },
  {
    key: "*.iceConnectionState",
    category: "webrtc",
    severity: "info",
    description: "Sibling of iceGatheringState; less commonly load-bearing for fingerprinting.",
  },
  {
    key: "*.getStats",
    category: "webrtc",
    severity: "medium",
    description: "RTCPeerConnection.getStats(). Returns the WebRTC stats dictionary — RTT, jitter, congestion-window samples. Used in 2014/2020 Markov-chain encrypted-traffic-classification work and by some advanced detectors to fingerprint the local network path.",
    botDetectionTell: true,
  },
  {
    key: "RTCDataChannel",
    category: "webrtc",
    severity: "medium",
    description: "RTCDataChannel constructor reference. Detectors create one to force ICE gathering without media permissions; the channel itself is also a *peer-to-peer exfil sink* that bypasses the conventional fetch/XHR/sendBeacon enumeration.",
    botDetectionTell: true,
  },
  {
    key: "*.send",
    category: "webrtc",
    severity: "low",
    description: "Generic *.send — fires for WebSocket.send, RTCDataChannel.send, and others. Treat in context: alone it's noisy; in combination with RTCPeerConnection construction it's a P2P exfil sink not visible to the normal HTTP-sink enumeration.",
  },
  {
    key: "*.bufferedAmount",
    category: "webrtc",
    severity: "info",
    description: "RTCDataChannel.bufferedAmount / WebSocket.bufferedAmount. Backpressure probe.",
  },
  {
    key: "*.sdp",
    category: "webrtc",
    severity: "medium",
    description: "RTCSessionDescription.sdp. The full SDP text containing every codec, header extension, and ICE candidate the offer/answer expressed. High-entropy fingerprint axis — the codec ordering alone can pin a UA's actual engine version.",
    botDetectionTell: true,
  },
];
