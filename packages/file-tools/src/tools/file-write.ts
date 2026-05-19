import type { SandboxManager } from "@iquantum/sandbox";
import { z } from "zod";
import type { FileTool } from "../index";
import { sanitizeSandboxPath } from "../sanitize";
import { collectExec, shellQuote } from "./common";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    content: { type: "string" },
  },
  required: ["path", "content"],
  additionalProperties: false,
} as const;

const inputParser = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export class FileWriteTool implements FileTool {
  readonly name = "file_write";
  readonly description = "Create or overwrite a file inside the sandbox.";
  readonly inputSchema = inputSchema;
  readonly mutates = true;
  readonly #maxBytes: number;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  async execute(
    input: unknown,
    sandbox: Pick<SandboxManager, "exec">,
    sessionId: string,
  ): Promise<string> {
    const parsed = inputParser.parse(input);
    const byteLength = Buffer.byteLength(parsed.content, "utf8");

    if (byteLength > this.#maxBytes) {
      return `Error: content is ${byteLength} bytes, exceeding the ${this.#maxBytes} byte limit`;
    }

    const path = sanitizeSandboxPath(parsed.path);
    const encoded = Buffer.from(parsed.content, "utf8").toString("base64");
    const result = await collectExec(
      await sandbox.exec(
        sessionId,
        `mkdir -p -- ${shellQuote(
          dirname(path),
        )} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(
          path,
        )}`,
      ),
    );

    if (result.exitCode !== 0) {
      return `Error: failed to write ${parsed.path}: ${result.stderr.trim()}`;
    }

    return `Written ${byteLength} bytes to ${parsed.path}`;
  }
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}
