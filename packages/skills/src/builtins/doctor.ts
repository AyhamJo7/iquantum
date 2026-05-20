import type { Skill } from "../index";

export const doctorSkill: Skill = {
  name: "doctor",
  description: "Run local diagnostics",
  async run(_args, ctx) {
    if (ctx.runDoctor) {
      await ctx.runDoctor(ctx.config);
      return;
    }

    ctx.dispatch({
      type: "system_message",
      text: "Run `iq doctor` from the shell for full diagnostics.",
      level: "info",
    });
  },
};
