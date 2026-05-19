import { analyze } from "script2builtins";
import type { Report, AnalyzeOptions } from "script2builtins/types";

/**
 * Fetch a URL and run the static analyzer on the body. No browser
 * launched. Useful when you've identified a single detector URL and
 * want a fast read on it without paying the cost of a full dynamic
 * run.
 *
 * Equivalent to:
 *   curl -sL <url> | script2builtins -
 *
 * but with the same import surface as {@link run} so consumers don't
 * have to know which package owns which.
 */
export async function analyzeUrl(
  url: string,
  opts: AnalyzeOptions & { headers?: Record<string, string> } = {},
): Promise<Report> {
  const { headers, ...analyzeOpts } = opts;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`analyzeUrl: ${url} → HTTP ${res.status}`);
  }
  const source = await res.text();
  return analyze(source, { name: url, ...analyzeOpts });
}
