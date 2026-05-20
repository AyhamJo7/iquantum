import type { SandboxManager } from "@iquantum/sandbox";
import { z } from "zod";
import type { FileTool } from "../index";
import { sanitizeSandboxPath } from "../sanitize";
import { collectExec, shellQuote } from "./common";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    offset: { type: "number" },
    limit: { type: "number" },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const inputParser = z.object({
  path: z.string().min(1),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});

export class FileReadTool implements FileTool {
  readonly name = "file_read";
  readonly description =
    "Read a file inside the sandbox workspace with optional line offset and limit.";
  readonly inputSchema = inputSchema;

  async execute(
    input: unknown,
    sandbox: Pick<SandboxManager, "exec">,
    sessionId: string,
  ): Promise<string> {
    const parsed = inputParser.parse(input);
    const path = sanitizeSandboxPath(parsed.path);
    const result = await collectExec(
      await sandbox.exec(sessionId, `cat -n -- ${shellQuote(path)}`),
    );

    if (result.exitCode !== 0) {
      return `Error: file not found: ${parsed.path}`;
    }

    const lines = parseNumberedLines(result.stdout);
    const start = parsed.offset ?? 1;
    const endExclusive = parsed.limit
      ? start + parsed.limit
      : Number.POSITIVE_INFINITY;
    const selected = lines.filter(
      (line) => line.number >= start && line.number < endExclusive,
    );
    const end = selected.at(-1)?.number ?? start;
    const content = selected
      .map((line) => `${line.number}\t${line.text}`)
      .join("\n");

    return `${parsed.path} (lines ${start}-${end}):\n${content}`;
  }

  async readRaw(
    pathInput: string,
    sandbox: Pick<SandboxManager, "exec">,
    sessionId: string,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const path = sanitizeSandboxPath(pathInput);
    const result = await collectExec(
      await sandbox.exec(sessionId, `cat -- ${shellQuote(path)}`),
    );

    if (result.exitCode !== 0) {
      return { ok: false, error: `Error: file not found: ${pathInput}` };
    }

    return { ok: true, content: result.stdout };
  }
}

function parseNumberedLines(
  stdout: string,
): Array<{ number: number; text: string }> {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const match = line.match(/^\s*(\d+)\t?(.*)$/);
      if (!match) {
        return { number: index + 1, text: line };
      }

      return {
        number: Number(match[1]),
        text: match[2] ?? "",
      };
    });
}
