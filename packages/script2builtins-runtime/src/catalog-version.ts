/**
 * Resolve the version of the bundled `script2builtins` catalog. Used
 * to stamp `catalogVersion` into reports so downstream consumers can
 * tell whether two reports came from the same catalog snapshot.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

let cached: string | null = null;

export function catalogVersion(): string {
  if (cached) return cached;
  try {
    const req = createRequire(import.meta.url);
    const path = req.resolve("script2builtins/package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { name: string; version: string };
    cached = `${pkg.name}@${pkg.version}`;
    return cached;
  } catch {
    // Fall back to local sibling layout (dev mode).
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const path = resolve(here, "..", "..", "script2builtins", "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { name: string; version: string };
      cached = `${pkg.name}@${pkg.version}`;
      return cached;
    } catch {
      cached = "script2builtins@unknown";
      return cached;
    }
  }
}
