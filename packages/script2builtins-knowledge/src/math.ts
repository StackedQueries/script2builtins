import type { ApiDefinition } from "./types.js";

/**
 * Math.* precision fingerprinting. ECMA-262 does not specify exact transcendental
 * results — implementations differ in their last-ULP behaviour. Chrome (fdlibm),
 * Firefox (different fdlibm fork), Safari (libm), and Node (V8/fdlibm) produce
 * subtly different doubles for inputs like `Math.tan(-1e300)`, `Math.acos(0.123456789)`,
 * and `Math.atanh(0.5)`. Tor Browser and other anti-fp tooling re-implement these
 * deterministically — which is itself a tell. CreepJS hashes ~20 of these values.
 */
export const mathApis: ApiDefinition[] = [
  {
    key: "Math.acos",
    category: "math",
    severity: "medium",
    description: "Inverse-cosine precision varies across engines. Common probe input.",
    botDetectionTell: true,
  },
  {
    key: "Math.acosh",
    category: "math",
    severity: "medium",
    description: "Inverse hyperbolic cosine. Fingerprint axis.",
  },
  {
    key: "Math.asin",
    category: "math",
    severity: "medium",
    description: "Inverse sine. Last-ULP differences across engines.",
    botDetectionTell: true,
  },
  {
    key: "Math.asinh",
    category: "math",
    severity: "medium",
    description: "Inverse hyperbolic sine.",
  },
  {
    key: "Math.atan",
    category: "math",
    severity: "medium",
    description: "Inverse tangent. CreepJS staple input.",
    botDetectionTell: true,
  },
  {
    key: "Math.atanh",
    category: "math",
    severity: "medium",
    description: "Inverse hyperbolic tangent. Strong cross-engine signal.",
    botDetectionTell: true,
  },
  {
    key: "Math.atan2",
    category: "math",
    severity: "medium",
    description: "Two-arg arctangent. Precision varies.",
  },
  {
    key: "Math.cbrt",
    category: "math",
    severity: "medium",
    description: "Cube root.",
  },
  {
    key: "Math.cos",
    category: "math",
    severity: "medium",
    description: "Cosine. Extreme inputs (e.g., cos(1e308)) reveal engine.",
    botDetectionTell: true,
  },
  {
    key: "Math.cosh",
    category: "math",
    severity: "medium",
    description: "Hyperbolic cosine.",
  },
  {
    key: "Math.exp",
    category: "math",
    severity: "medium",
    description: "Exponential. Edge-case precision differences.",
  },
  {
    key: "Math.expm1",
    category: "math",
    severity: "medium",
    description: "exp(x) - 1. Different rounding across engines.",
    botDetectionTell: true,
  },
  {
    key: "Math.log",
    category: "math",
    severity: "medium",
    description: "Natural log. Precision varies.",
  },
  {
    key: "Math.log1p",
    category: "math",
    severity: "medium",
    description: "log(1+x). Strong precision fingerprint for small x.",
    botDetectionTell: true,
  },
  {
    key: "Math.log10",
    category: "math",
    severity: "medium",
    description: "Base-10 logarithm.",
  },
  {
    key: "Math.log2",
    category: "math",
    severity: "medium",
    description: "Base-2 logarithm.",
  },
  {
    key: "Math.sin",
    category: "math",
    severity: "medium",
    description: "Sine. Extreme inputs are diagnostic.",
    botDetectionTell: true,
  },
  {
    key: "Math.sinh",
    category: "math",
    severity: "medium",
    description: "Hyperbolic sine.",
  },
  {
    key: "Math.sqrt",
    category: "math",
    severity: "low",
    description: "Square root. Usually IEEE-correct everywhere; included for completeness.",
  },
  {
    key: "Math.tan",
    category: "math",
    severity: "medium",
    description: "Tangent. `Math.tan(-1e300)` is a Tor-precision tell.",
    botDetectionTell: true,
  },
  {
    key: "Math.tanh",
    category: "math",
    severity: "medium",
    description: "Hyperbolic tangent.",
  },
  {
    key: "Math.hypot",
    category: "math",
    severity: "medium",
    description: "sqrt(sum of squares). Implementation differences in overflow handling.",
  },
  {
    key: "Math.pow",
    category: "math",
    severity: "medium",
    description: "Exponentiation. Last-ULP differences across engines.",
  },
  {
    key: "Math.fround",
    category: "math",
    severity: "low",
    description: "Round to nearest float32. Usually IEEE-correct.",
  },
];
