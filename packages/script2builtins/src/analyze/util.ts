import type { Location } from "../types.js";

export function locOf(node: any): Location | null {
  return node?.loc ?? null;
}

export function snippetOf(source: string, node: any): string {
  if (typeof node?.start !== "number" || typeof node?.end !== "number") return "";
  const raw = source.slice(node.start, Math.min(node.end, node.start + 120));
  return raw.replace(/\s+/g, " ").trim();
}
