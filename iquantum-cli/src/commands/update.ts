import { spawn } from "node:child_process";
import type { Writer } from "./daemon";

/**
 * Detects whether this CLI was installed via npm or bun by checking the
 * executable path. Falls back to npm when ambiguous.
 */
function detectPackageManager(): "npm" | "bun" {
  const execPath = process.execPath ?? "";
  if (execPath.includes(".bun") || execPath.endsWith("bun")) {
    // Check if bun global bin dir contains this script
    return "bun";
  }
  return "npm";
}

export async function runUpdate(writer: Writer): Promise<void> {
  const pm = detectPackageManager();
  const [cmd, ...args] =
    pm === "bun"
      ? ["bun", "install", "-g", "@iquantum/cli@latest"]
      : ["npm", "install", "-g", "@iquantum/cli@latest"];

  if (!cmd) throw new Error("Could not determine package manager");

  writer.writeln(`updating @iquantum/cli via ${pm}…`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("error", (err) => {
      reject(
        new Error(
          `Could not run ${pm}. Install it and retry, or update manually:\n  npm install -g @iquantum/cli@latest`,
          { cause: err },
        ),
      );
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${pm} exited with code ${code ?? "?"}`));
      }
    });
  });

  writer.writeln("update complete — restart iq to use the new version");
}
