import { describe, expect, it } from "vitest";
import { formatSessionMarkdown } from "./export-markdown";

describe("formatSessionMarkdown", () => {
  it("formats fixture messages with metadata, text, and tool JSON blocks", () => {
    const markdown = formatSessionMarkdown(
      {
        id: "session-1",
        createdAt: "2026-05-20T00:00:00.000Z",
        repoPath: "/repo",
      },
      [
        {
          role: "user",
          createdAt: "2026-05-20T00:01:00.000Z",
          content: "Fix the bug",
        },
        {
          role: "assistant",
          createdAt: "2026-05-20T00:02:00.000Z",
          content: [
            { type: "text", text: "Reading the file." },
            { type: "tool_use", id: "tool-1", name: "file_read" },
          ],
        },
      ],
    );

    expect(markdown).toMatchInlineSnapshot(`
      "# iquantum Session Export

      **Session ID**: session-1
      **Date**: 2026-05-20T00:00:00.000Z
      **Repo**: /repo

      ---

      ### [user] 2026-05-20T00:01:00.000Z

      Fix the bug

      ### [assistant] 2026-05-20T00:02:00.000Z

      Reading the file.

      \`\`\`json
      {
        "type": "tool_use",
        "id": "tool-1",
        "name": "file_read"
      }
      \`\`\`
      "
    `);
  });

  it("marks truncated exports", () => {
    expect(
      formatSessionMarkdown(
        { id: "session-1", createdAt: "now", repoPath: "/repo" },
        [],
        { truncated: true, messageLimit: 500 },
      ),
    ).toContain("Export truncated - showing first 500 messages only.");
  });
});
