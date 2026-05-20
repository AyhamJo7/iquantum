import type { Skill } from "../index";

export const rememberSkill: Skill = {
  name: "remember",
  description: "Save a project memory",
  async run(args, ctx) {
    const body = args.trim();
    if (!body) {
      ctx.dispatch({
        type: "system_message",
        text: "Usage: /remember <fact>",
        level: "error",
      });
      return;
    }

    await ctx.client.createMemory({
      type: "project",
      name: slugFromFact(body),
      description: "(from /remember)",
      body,
      pinned: false,
    });
    ctx.dispatch({ type: "system_message", text: "Saved.", level: "info" });
  },
};

function slugFromFact(fact: string): string {
  return (
    fact
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "memory"
  );
}
