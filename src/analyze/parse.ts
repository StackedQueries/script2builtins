import { Parser } from "acorn";
import type { Program } from "acorn";
import type { ParseInfo } from "../types.js";

export interface ParseResult {
  program: Program | null;
  info: ParseInfo;
}

const PARSE_OPTS = {
  ecmaVersion: "latest" as const,
  locations: true,
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
  allowHashBang: true,
};

/**
 * Parse JS source. Tries `module` first (more permissive for top-level
 * await/import/export); falls back to `script` mode on syntax error.
 * Bot-detection blobs are usually IIFEs or scripts, so we want both.
 */
export function parse(source: string, forced?: "script" | "module"): ParseResult {
  const errors: string[] = [];
  const order: ("module" | "script")[] = forced ? [forced] : ["module", "script"];

  for (const sourceType of order) {
    try {
      const program = Parser.parse(source, {
        ...PARSE_OPTS,
        sourceType,
      });
      return {
        program,
        info: { ok: true, sourceType, errors },
      };
    } catch (err) {
      errors.push(`${sourceType}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    program: null,
    info: { ok: false, sourceType: order[0] ?? "module", errors },
  };
}
