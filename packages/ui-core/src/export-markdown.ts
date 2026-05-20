export interface ExportMarkdownSession {
  id: string;
  createdAt: string;
  repoPath: string;
}

export interface ExportMarkdownMessage {
  role: string;
  content: unknown;
  createdAt: string;
}

export interface FormatSessionMarkdownOptions {
  truncated?: boolean;
  messageLimit?: number;
}

export function formatSessionMarkdown(
  session: ExportMarkdownSession,
  messages: ExportMarkdownMessage[],
  options: FormatSessionMarkdownOptions = {},
): string {
  const lines: string[] = [
    "# iquantum Session Export",
    "",
    `**Session ID**: ${session.id}`,
    `**Date**: ${session.createdAt}`,
    `**Repo**: ${session.repoPath}`,
    "",
    "---",
    "",
  ];

  for (const msg of messages) {
    lines.push(`### [${msg.role}] ${msg.createdAt}`, "");
    appendContent(lines, msg.content);
  }

  if (options.truncated) {
    lines.push(
      "---",
      "",
      `> Export truncated - showing first ${options.messageLimit ?? messages.length} messages only.`,
      "",
    );
  }

  return lines.join("\n");
}

function appendContent(lines: string[], content: unknown): void {
  if (typeof content === "string") {
    lines.push(content, "");
    return;
  }

  if (!Array.isArray(content)) {
    lines.push("```json", JSON.stringify(content, null, 2), "```", "");
    return;
  }

  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block.type === "text" && typeof block.text === "string") {
      lines.push(block.text, "");
    } else if (block.type === "tool_use" || block.type === "tool_result") {
      lines.push("```json", JSON.stringify(block, null, 2), "```", "");
    }
  }
}
