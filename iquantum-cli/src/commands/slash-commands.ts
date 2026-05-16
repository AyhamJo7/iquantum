import type { CommandContext, LocalCommand } from "./registry";
import { CommandRegistry } from "./registry";

const COMMIT_HASH_RE = /^[0-9a-f]{7,64}$/i;

function sysInfo(ctx: CommandContext, text: string): void {
  ctx.dispatch({ type: "system_message", text, level: "info" });
}

function sysError(ctx: CommandContext, text: string): void {
  ctx.dispatch({ type: "system_message", text, level: "error" });
}

const commandDefs: LocalCommand[] = [
  {
    name: "help",
    description: "Show available commands",
    run(_, ctx) {
      const rows = ctx.registry
        .getAll()
        .map((c) => `  /${c.name.padEnd(12)} ${c.description}`)
        .join("\n");
      sysInfo(ctx, `Commands:\n${rows}`);
    },
  },
  {
    name: "status",
    description: "Show session ID, model, and token count",
    run(_, ctx) {
      sysInfo(
        ctx,
        [
          `Session : ${ctx.sessionId}`,
          `Model   : ${ctx.modelName}`,
          `Tokens  : ${ctx.tokenCount}`,
        ].join("\n"),
      );
    },
  },
  {
    name: "model",
    description: "Show current model configuration",
    run(_, ctx) {
      const arch =
        process.env.IQUANTUM_ARCHITECT_MODEL ?? "(unset — using default)";
      const editor =
        process.env.IQUANTUM_EDITOR_MODEL ?? "(unset — using default)";
      sysInfo(
        ctx,
        [
          `Architect : ${arch}`,
          `Editor    : ${editor}`,
          "Hint: set IQUANTUM_ARCHITECT_MODEL or IQUANTUM_EDITOR_MODEL to override",
        ].join("\n"),
      );
    },
  },
  {
    name: "clear",
    description: "Clear conversation history and transcript",
    async run(_, ctx) {
      try {
        await ctx.client.deleteMessages(ctx.sessionId);
        ctx.dispatch({ type: "clear_transcript" });
      } catch {
        sysError(ctx, "Failed to clear conversation history.");
      }
    },
  },
  {
    name: "compact",
    description: "Compact conversation context now",
    async run(_, ctx) {
      sysInfo(ctx, "Compacting context…");

      try {
        const result = await ctx.client.compact(ctx.sessionId);
        sysInfo(
          ctx,
          result.compacted
            ? `Context compacted. Summary: ${result.summary ?? "(none)"}`
            : "Nothing to compact.",
        );
      } catch {
        sysError(ctx, "Compaction failed.");
      }
    },
  },
  {
    name: "plan",
    description: "Show the current plan",
    async run(_, ctx) {
      try {
        const plan = await ctx.client.currentPlan(ctx.sessionId);

        if (!plan) {
          sysInfo(ctx, "No active plan.");
          return;
        }

        sysInfo(ctx, `Plan [${plan.status}]:\n${plan.content}`);
      } catch {
        sysError(ctx, "Failed to fetch plan.");
      }
    },
  },
  {
    name: "approve",
    description: "Approve the current plan",
    async run(_, ctx) {
      try {
        await ctx.client.approve(ctx.sessionId);
        sysInfo(ctx, "Plan approved.");
      } catch (e) {
        sysError(
          ctx,
          `Approve failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "reject",
    description: "Reject the current plan with feedback (/reject <reason>)",
    async run(args, ctx) {
      const feedback = args.trim();

      if (!feedback) {
        sysError(ctx, "Usage: /reject <reason>");
        return;
      }

      try {
        await ctx.client.reject(ctx.sessionId, feedback);
        sysInfo(ctx, "Plan rejected.");
      } catch (e) {
        sysError(
          ctx,
          `Reject failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "restore",
    description: "List checkpoints or restore to one (/restore <hash>)",
    async run(args, ctx) {
      const hash = args.trim();

      if (hash) {
        if (!COMMIT_HASH_RE.test(hash)) {
          sysError(ctx, "Invalid commit hash.");
          return;
        }

        try {
          await ctx.client.restore(ctx.sessionId, hash);
          sysInfo(ctx, `Restored to ${hash.slice(0, 7)}.`);
        } catch (e) {
          sysError(
            ctx,
            `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        return;
      }

      try {
        const checkpoints = await ctx.client.listCheckpoints(ctx.sessionId);

        if (!checkpoints.length) {
          sysInfo(ctx, "No checkpoints available.");
          return;
        }

        const list = checkpoints
          .map(
            (cp) =>
              `  ${cp.commitHash.slice(0, 7)}  ${cp.commitMessage.slice(0, 60)}`,
          )
          .join("\n");
        sysInfo(
          ctx,
          `Checkpoints:\n${list}\n\nUse /restore <hash> to restore.`,
        );
      } catch {
        sysError(ctx, "Failed to list checkpoints.");
      }
    },
  },
  {
    name: "mcp",
    description: "List configured MCP servers and their tools",
    async run(_, ctx) {
      try {
        const tools = await ctx.client.listMcpTools();

        if (!tools.length) {
          sysInfo(
            ctx,
            "No MCP tools available. Set IQUANTUM_MCP_SERVERS to configure.",
          );
          return;
        }

        const list = tools
          .map((t) => `  ${t.serverName}/${t.name}  ${t.description}`)
          .join("\n");
        sysInfo(ctx, `MCP tools (${tools.length}):\n${list}`);
      } catch {
        sysError(ctx, "Failed to fetch MCP tools.");
      }
    },
  },
  {
    name: "quit",
    description: "Exit iq (sandbox container persists)",
    run() {
      process.exit(0);
    },
  },
];

export function makeCommandRegistry(): CommandRegistry {
  return new CommandRegistry(commandDefs);
}
