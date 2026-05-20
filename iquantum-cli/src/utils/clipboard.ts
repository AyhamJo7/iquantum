import { spawnSync } from "node:child_process";

export class ClipboardUnavailableError extends Error {
  constructor() {
    super(
      "No clipboard utility found. Install xclip or xsel, or use clip.exe on WSL2.",
    );
    this.name = "ClipboardUnavailableError";
  }
}

export function copyToClipboard(text: string): void {
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: "clip.exe", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];

  for (const { cmd, args } of candidates) {
    const result = spawnSync(cmd, args, {
      input: text,
      timeout: 3000,
      stdio: ["pipe", "ignore", "ignore"],
    });

    if (result.status === 0) {
      return;
    }
  }

  throw new ClipboardUnavailableError();
}
