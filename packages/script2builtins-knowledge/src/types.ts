/**
 * Catalog-shape types owned by `script2builtins-knowledge`. These describe
 * the structure of a single API entry and the SoK layer taxonomy used to
 * bucket entries into the academic literature. The static analyzer
 * (`script2builtins`) and the runtime driver (`script2builtins-runtime`)
 * both depend on these shapes via this package; nothing about parsing,
 * walking, or reporting lives here.
 */

/**
 * Severity tiers used across the catalog.
 *
 * - `info`   ubiquitous APIs that show up in plenty of legitimate code.
 * - `low`    fingerprint-relevant but low entropy or expected.
 * - `medium` strong fingerprint signals (canvas/audio/WebGL surfaces).
 * - `high`   bot-specific tells or high-leakage operations.
 */
export type Severity = "info" | "low" | "medium" | "high";

/**
 * SoK (Abel) L1–L4 anti-automation layer taxonomy. Used as an optional
 * tag on {@link ApiDefinition} so reports can cross-walk findings to
 * the academic literature.
 *
 * - `L1a` — Static environmental introspection (UA, screen, plugins).
 * - `L1b` — Behavioral biometrics (mouse curves, keystroke dynamics).
 * - `L2`  — Obfuscation / source-level integrity checks.
 * - `L3`  — Execution traps (anti-logger, anti-debug, console.* hooks).
 * - `L4`  — Chronometric integrity (timing-delta, clock-skew probes).
 */
export type SokLayer = "L1a" | "L1b" | "L2" | "L3" | "L4";

/**
 * One entry in the fingerprinting-API catalog. Category files in this
 * package export arrays of these.
 */
export interface ApiDefinition {
  /**
   * Match key. Two forms:
   *   - `"navigator.userAgent"` — chain (after global-root stripping) starts with this.
   *   - `"*.toDataURL"` — chain ends with this suffix, root is irrelevant.
   */
  key: string;
  /** Logical category (used for grouping in reports). */
  category: string;
  /** Short human description of what the API leaks or signals. */
  description: string;
  severity: Severity;
  /** Set when this access is a strong indicator of bot detection. */
  botDetectionTell?: boolean;
  /** Notes on common evasion strategies for users reverse-engineering. */
  evasion?: string;
  /**
   * When set, an access only matches if its `firstStringArg` equals one
   * of these strings. Used to split polymorphic methods such as
   * `getContext("2d")` vs `getContext("webgl")`.
   */
  argMatch?: string[];
  /**
   * Optional SoK (Abel 2024) anti-automation layer label. Lets the
   * renderer bucket findings into the field's vendor-neutral vocabulary.
   * Omitted when the entry doesn't cleanly fit one of L1a/L1b/L2/L3/L4
   * — most static-introspection entries are L1a by default but only
   * the most representative ones carry the explicit tag, to keep the
   * report readable.
   */
  layer?: SokLayer;
}
