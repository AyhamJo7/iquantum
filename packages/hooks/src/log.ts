import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function appendHookLog(message: string): Promise<void> {
  const dir = join(homedir(), ".iquantum", "logs");
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  await appendFile(join(dir, "hooks.log"), `${message}\n`, "utf8").catch(
    () => undefined,
  );
}
