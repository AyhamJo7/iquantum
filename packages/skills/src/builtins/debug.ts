import type { Skill } from "../index";

export const debugSkill: Skill = {
  name: "debug",
  description: "Run the next task with a structured debugging context block",
  chatAvailable: false,
  async run(args, ctx) {
    const prompt = args.trim();
    if (!prompt) {
      ctx.dispatch({
        type: "system_message",
        text: "Usage: /debug <prompt or error details>",
        level: "error",
      });
      return;
    }

    await ctx.client.postMessage(
      ctx.sessionId,
      [
        "Debugging context:",
        "```",
        `Last error: ${ctx.lastError ?? "(not available)"}`,
        "",
        prompt,
        "```",
        "",
        "Investigate the failure, identify the root cause, and implement the fix.",
      ].join("\n"),
    );
  },
};
