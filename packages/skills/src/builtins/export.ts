import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "../index";

export const exportSkill: Skill = {
  name: "export",
  description: "Export this session to markdown",
  async run(_args, ctx) {
    const markdown = await ctx.client.exportSession(ctx.sessionId, {
      format: "markdown",
    });
    const filePath = join(
      process.cwd(),
      `iquantum-session-${ctx.sessionId}.md`,
    );
    await writeFile(filePath, markdown, "utf8");
    ctx.dispatch({
      type: "system_message",
      text: `Exported ${filePath}`,
      level: "info",
    });
  },
};
