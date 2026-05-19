import type { ApiDefinition } from "./types.js";

/**
 * Intl.* APIs. Locale/timezone resolution is one of the strongest cross-OS
 * fingerprint axes — ICU build, CLDR version, and host-platform locale data
 * all show through Intl outputs. CreepJS uses formatted strings from every
 * Intl constructor for its locale-system signature.
 */
export const intlApis: ApiDefinition[] = [
  {
    key: "Intl.DateTimeFormat",
    category: "intl",
    severity: "medium",
    botDetectionTell: true,
    description: "resolvedOptions().timeZone leaks the IANA timezone string. format()/formatToParts() outputs vary across ICU builds (Chrome vs Node vs Firefox).",
    evasion: "Spoof both the timezone and the locale via Object.defineProperty on the prototype; ensure consistency with Date.prototype.getTimezoneOffset and navigator.languages.",
  },
  {
    key: "Intl.NumberFormat",
    category: "intl",
    severity: "medium",
    description: "resolvedOptions().locale + format() output (currency symbol position, decimal separator) leaks ICU locale. Compact-notation strings vary across versions.",
  },
  {
    key: "Intl.Collator",
    category: "intl",
    severity: "low",
    description: "Locale-aware comparison. compare() ordering of edge-case strings reveals the underlying ICU collation table.",
  },
  {
    key: "Intl.DisplayNames",
    category: "intl",
    severity: "medium",
    botDetectionTell: true,
    description: "of(code) returns localized language/region/script names. CreepJS uses it as a high-signal locale-system axis — different platforms ship different display-name tables.",
  },
  {
    key: "Intl.ListFormat",
    category: "intl",
    severity: "medium",
    description: "format([...]) joins items with locale-specific separators ('and'/','/' und '/etc.). Output varies across ICU versions.",
  },
  {
    key: "Intl.PluralRules",
    category: "intl",
    severity: "medium",
    description: "select(n) returns the plural form ('one'/'few'/'many'/'other') for a locale. Subtle cross-platform differences for less-common locales.",
  },
  {
    key: "Intl.RelativeTimeFormat",
    category: "intl",
    severity: "medium",
    botDetectionTell: true,
    description: "format(value, unit) returns 'in 3 days', 'next year', etc. Strong locale-system fingerprint axis used by CreepJS.",
  },
  {
    key: "Intl.Locale",
    category: "intl",
    severity: "low",
    description: "Locale tag parser. Constructor + resolvedOptions exposes default calendar/numbering system/case-first behaviour.",
  },
  {
    key: "Intl.Segmenter",
    category: "intl",
    severity: "medium",
    description: "Grapheme/word/sentence segmentation. Different ICU builds segment emoji ZWJ sequences differently — a tell for Chromium vs WebKit vs Gecko.",
  },
  {
    key: "*.resolvedOptions",
    category: "intl",
    severity: "medium",
    description: "Universal Intl.* method that exposes the resolved locale tag, timezone, calendar, numbering system, and per-formatter defaults. Heavy on the Intl.X.resolvedOptions() pattern in fingerprinters.",
  },
  {
    key: "*.formatToParts",
    category: "intl",
    severity: "medium",
    description: "Structured formatter output. Detectors compare specific parts (literal separators, currency placement) across locales rather than the whole string.",
  },
];
