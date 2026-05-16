import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads ~/.iquantum/config.json (or <dir>/config.json) synchronously and
 * returns its contents as an env-var-shaped object (uppercase string keys).
 * Returns {} on any error so callers never need to guard against throws.
 * Env vars passed by the caller always win over values returned here.
 */
export function readConfigFileSync(dir: string): NodeJS.ProcessEnv {
  try {
    const raw = readFileSync(join(dir, "config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const result: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
