import type { SandboxManager } from "@iquantum/sandbox";
import { z } from "zod";
import type { FileTool } from "../index";
import { sanitizeSandboxPath } from "../sanitize";
import { collectExec, shellQuote, stripWorkspacePrefix } from "./common";

const inputSchema = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    flags: { type: "string" },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

const inputParser = z.object({
  pattern: z.string().min(1).max(1000),
  path: z.string().min(1).optional(),
  flags: z
    .string()
    .regex(/^[inw]*$/)
    .optional(),
});

export class FileGrepTool implements FileTool {
  readonly name = "file_grep";
  readonly description = "Search sandbox files with grep.";
  readonly inputSchema = inputSchema;

  async execute(
    input: unknown,
    sandbox: Pick<SandboxManager, "exec">,
    sessionId: string,
  ): Promise<string> {
    const parsed = inputParser.safeParse(input);

    if (!parsed.success) {
      const pattern = (input as { pattern?: unknown })?.pattern;
      if (typeof pattern === "string" && pattern.length > 1000) {
        return "Error: pattern exceeds 1000 characters";
      }
      return `Error: invalid grep input: ${parsed.error.issues[0]?.message ?? "unknown error"}`;
    }

    const target = sanitizeSandboxPath(parsed.data.path ?? ".");
    const flags = parsed.data.flags ?? "";
    const result = await collectExec(
      await sandbox.exec(
        sessionId,
        `grep -rn${flags} -- ${shellQuote(parsed.data.pattern)} ${shellQuote(
          target,
        )} 2>/dev/null | head -200`,
      ),
    );

    if (!result.stdout.trim()) {
      return "No matches found";
    }

    return stripWorkspacePrefix(result.stdout.trim());
  }
}
