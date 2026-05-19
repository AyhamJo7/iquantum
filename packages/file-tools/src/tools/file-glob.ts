import type { SandboxManager } from "@iquantum/sandbox";
import { z } from "zod";
import type { FileTool } from "../index";
import { sanitizeSandboxPath } from "../sanitize";
import { collectExec, shellQuote, stripWorkspacePrefix } from "./common";

const inputSchema = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    base: { type: "string" },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

const inputParser = z.object({
  pattern: z.string().min(1),
  base: z.string().min(1).optional(),
});

const unsafePatternChars = /[;&|$]/;

export class FileGlobTool implements FileTool {
  readonly name = "file_glob";
  readonly description = "Find files in the sandbox using a glob-style name.";
  readonly inputSchema = inputSchema;

  async execute(
    input: unknown,
    sandbox: Pick<SandboxManager, "exec">,
    sessionId: string,
  ): Promise<string> {
    const parsed = inputParser.parse(input);

    if (unsafePatternChars.test(parsed.pattern)) {
      return "Error: pattern contains unsupported shell metacharacters";
    }

    const base = sanitizeSandboxPath(parsed.base ?? ".");
    const result = await collectExec(
      await sandbox.exec(
        sessionId,
        `find ${shellQuote(base)} -name ${shellQuote(
          parsed.pattern,
        )} -type f | sort`,
      ),
    );

    if (result.exitCode !== 0) {
      return `Error: glob failed: ${result.stderr.trim()}`;
    }

    const matches = result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 500)
      .map(stripWorkspacePrefix);

    return matches.length > 0 ? matches.join("\n") : "No files found";
  }
}
