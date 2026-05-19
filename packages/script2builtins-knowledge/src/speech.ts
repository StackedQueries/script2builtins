import type { ApiDefinition } from "./types.js";

/**
 * Speech Synthesis. The list of installed voices is a high-entropy fingerprint
 * because it reflects the OS-installed TTS engines (macOS ships ~50 voices,
 * Windows ~15, Linux often 0, headless Chrome 0). The voice URIs include
 * vendor-specific prefixes that pin down the OS family.
 */
export const speechApis: ApiDefinition[] = [
  {
    key: "speechSynthesis",
    category: "speech",
    severity: "high",
    botDetectionTell: true,
    description: "Web Speech API root. Mere access is benign but is the gateway to getVoices() — one of the strongest OS-fingerprint surfaces.",
    evasion: "Headless Chrome returns an empty voice list by default; serve a curated list that matches the claimed platform.",
  },
  {
    key: "speechSynthesis.getVoices",
    category: "speech",
    severity: "high",
    botDetectionTell: true,
    description: "Returns the array of SpeechSynthesisVoice. Length, voiceURI prefixes (com.apple.voice.* / Microsoft / native), default flags, and lang tags identify the OS+browser combo.",
    evasion: "Override getVoices on SpeechSynthesis.prototype to return a plausible per-platform set; the call is async on first invocation, mirror that timing.",
  },
  {
    key: "*.getVoices",
    category: "speech",
    severity: "high",
    botDetectionTell: true,
    description: "Aliased speechSynthesis.getVoices receiver. Catches `var s = speechSynthesis; s.getVoices()` patterns the analyzer may not chain through.",
  },
  {
    key: "speechSynthesis.onvoiceschanged",
    category: "speech",
    severity: "medium",
    description: "Event fired when async voice list resolves. Real Chrome fires once; headless never fires.",
  },
  {
    key: "SpeechSynthesisVoice",
    category: "speech",
    severity: "low",
    description: "Voice class constructor; checked for existence on the global.",
  },
  {
    key: "SpeechSynthesisUtterance",
    category: "speech",
    severity: "info",
    description: "Utterance constructor; rarely fingerprinted on its own.",
  },
];
