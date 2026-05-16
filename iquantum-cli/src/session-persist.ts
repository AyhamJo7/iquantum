import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function readLastSession(
  iquantumDir: string,
): Promise<string | null> {
  try {
    const raw = await readFile(join(iquantumDir, "last-session"), "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export async function writeLastSession(
  iquantumDir: string,
  sessionId: string,
): Promise<void> {
  await mkdir(iquantumDir, { recursive: true });
  await writeFile(join(iquantumDir, "last-session"), sessionId, "utf8");
}
