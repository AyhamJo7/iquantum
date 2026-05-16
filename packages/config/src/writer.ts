import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Atomically merges `updates` into <dir>/config.json.
 * Existing keys not present in `updates` are preserved.
 * Creates the directory and file if they do not exist.
 */
export async function writeConfigFile(
  dir: string,
  updates: Record<string, string>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, "config.json");

  let existing: Record<string, string> = {};
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      existing = parsed as Record<string, string>;
    }
  } catch {
    // File absent or malformed — start fresh.
  }

  const merged = { ...existing, ...updates };
  const tempPath = join(
    tmpdir(),
    `iquantum-config-${randomBytes(8).toString("hex")}.json`,
  );
  await writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(tempPath, configPath);
}
