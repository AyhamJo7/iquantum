import type { SandboxManager } from "@iquantum/sandbox";
import { z } from "zod";
import type { FileTool } from "../index";
import type { FileReadTool } from "./file-read";
import type { FileWriteTool } from "./file-write";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
  },
  required: ["path", "old_string", "new_string"],
  additionalProperties: false,
} as const;

const inputParser = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
});

export class FileEditTool implements FileTool {
  readonly name = "file_edit";
  readonly description =
    "Replace one exact, unique string occurrence inside a sandbox file.";
  readonly inputSchema = inputSchema;
  readonly mutates = true;
  readonly #fileReadTool: FileReadTool;
  readonly #fileWriteTool: FileWriteTool;

  constructor(fileReadTool: FileReadTool, fileWriteTool: FileWriteTool) {
    this.#fileReadTool = fileReadTool;
    this.#fileWriteTool = fileWriteTool;
  }

  async execute(
    input: unknown,
    sandbox: Pick<SandboxManager, "exec">,
    sessionId: string,
  ): Promise<string> {
    const parsed = inputParser.parse(input);
    const current = await this.#fileReadTool.readRaw(
      parsed.path,
      sandbox,
      sessionId,
    );

    if (!current.ok) {
      return current.error;
    }

    const occurrences = countOccurrences(current.content, parsed.old_string);
    if (occurrences === 0) {
      return `Error: old_string not found in ${parsed.path}`;
    }
    if (occurrences > 1) {
      return `Error: old_string is not unique in ${parsed.path} (found ${occurrences} occurrences)`;
    }

    const next = current.content.replace(parsed.old_string, parsed.new_string);
    const writeResult = await this.#fileWriteTool.execute(
      { path: parsed.path, content: next },
      sandbox,
      sessionId,
    );

    if (writeResult.startsWith("Error:")) {
      return writeResult;
    }

    return `Edited ${parsed.path}: replaced 1 occurrence`;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;

  while (true) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) return count;
    count += 1;
    idx += needle.length;
  }
}
