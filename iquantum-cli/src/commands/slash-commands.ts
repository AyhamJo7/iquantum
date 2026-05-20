import { loadConfig, MissingApiKeyError } from "@iquantum/config";
import { formatContextStats } from "../components/context-bar-format";
import { ClipboardUnavailableError, copyToClipboard } from "../utils/clipboard";
import { formatDoctorResults, runAllChecks } from "./doctor";
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
    name: "remember",
    description: "Save a memory (/remember <fact>)",
    async run(args, ctx) {
      const body = args.trim();

      if (!body) {
        sysError(ctx, "Usage: /remember <fact>");
        return;
      }

      try {
        await ctx.client.createMemory({
          type: "project",
          name: slugFromFact(body),
          description: "(from /remember)",
          body,
          pinned: false,
        });
        sysInfo(ctx, "Saved.");
      } catch (e) {
        sysError(
          ctx,
          `Remember failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "memory",
    description: "Manage memories (/memory [list|forget <name>|pin <name>])",
    async run(args, ctx) {
      const [subcommand = "list", name] = args.trim().split(/\s+/, 2);

      try {
        if (subcommand === "list") {
          const memories = await ctx.client.listMemories();
          if (!memories.length) {
            sysInfo(ctx, "No memories saved.");
            return;
          }

          sysInfo(
            ctx,
            `Memories:\n${memories.map(formatMemoryRow).join("\n")}`,
          );
          return;
        }

        if ((subcommand === "forget" || subcommand === "pin") && name) {
          const memories = await ctx.client.listMemories();
          const memory = memories.find((entry) => entry.name === name);
          if (!memory) {
            sysError(ctx, `Memory not found: ${name}`);
            return;
          }

          if (subcommand === "forget") {
            await ctx.client.deleteMemory(memory.id);
            sysInfo(ctx, `Forgot ${name}.`);
          } else {
            await ctx.client.updateMemory(memory.id, { pinned: true });
            sysInfo(ctx, `Pinned ${name}.`);
          }
          return;
        }

        sysError(ctx, "Usage: /memory [list|forget <name>|pin <name>]");
      } catch (e) {
        sysError(
          ctx,
          `Memory command failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
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
    name: "skills",
    description: "List loaded skills",
    run(_, ctx) {
      const skills = ctx.registry.getSkillCommands();
      if (skills.length === 0) {
        sysInfo(ctx, "No skills loaded.");
        return;
      }

      sysInfo(
        ctx,
        `Skills:\n${skills
          .map((skill) => `  /${skill.name.padEnd(12)} ${skill.description}`)
          .join("\n")}`,
      );
    },
  },
  {
    name: "hooks",
    description: "List loaded hooks",
    async run(_, ctx) {
      try {
        const hooks = (await ctx.client.listHooks?.()) ?? [];
        if (!hooks.length) {
          sysInfo(ctx, "No hooks loaded.");
          return;
        }

        sysInfo(
          ctx,
          `Hooks:\n${hooks
            .map(
              (hook) =>
                `  ${hook.name.padEnd(16)} ${hook.events.join(", ")}  ${hook.filePath}`,
            )
            .join("\n")}`,
        );
      } catch (e) {
        sysError(
          ctx,
          `Hooks failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "keybindings",
    description: "Show active keybindings",
    run(_, ctx) {
      const rows = Object.entries(ctx.keybindings ?? {});
      if (rows.length === 0) {
        sysInfo(ctx, "No keybindings loaded.");
        return;
      }

      sysInfo(
        ctx,
        `Keybindings:\n${rows
          .map(([chord, action]) => `  ${chord.padEnd(16)} ${action}`)
          .join("\n")}`,
      );
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
      sysInfo(
        ctx,
        [
          `Architect : ${ctx.modelName}`,
          `Editor    : ${ctx.editorModel}`,
          "Hint: use `iq config set` or environment variables to override",
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
    chatUnavailable: true,
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
    chatUnavailable: true,
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
    chatUnavailable: true,
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
    name: "task",
    description: "Start a PIV task in task mode (/task <prompt>)",
    async run(args, ctx) {
      const prompt = args.trim();

      if (!prompt) {
        sysError(ctx, "Usage: /task <prompt>");
        return;
      }

      try {
        await ctx.client.postMessage(ctx.sessionId, prompt);
      } catch (e) {
        sysError(
          ctx,
          `Task failed: ${e instanceof Error ? e.message : String(e)}`,
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
    name: "fast",
    description: "Switch to fast (editor-model) effort",
    async run(_, ctx) {
      try {
        await ctx.client.patchSessionConfig(ctx.sessionId, { effort: "fast" });
        sysInfo(ctx, "Effort set to fast.");
      } catch (e) {
        sysError(
          ctx,
          `Failed to set effort: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "normal",
    description: "Switch to normal effort (default)",
    async run(_, ctx) {
      try {
        await ctx.client.patchSessionConfig(ctx.sessionId, {
          effort: "normal",
        });
        sysInfo(ctx, "Effort set to normal.");
      } catch (e) {
        sysError(
          ctx,
          `Failed to set effort: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "thorough",
    description: "Switch to thorough (extended-thinking) effort",
    async run(_, ctx) {
      try {
        await ctx.client.patchSessionConfig(ctx.sessionId, {
          effort: "thorough",
        });
        sysInfo(ctx, "Effort set to thorough.");
      } catch (e) {
        sysError(
          ctx,
          `Failed to set effort: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "context",
    description: "Show context token breakdown",
    async run(_, ctx) {
      try {
        const stats = await ctx.client.getContextStats(ctx.sessionId);
        sysInfo(ctx, formatContextStats(stats));
      } catch (e) {
        sysError(
          ctx,
          `Failed to fetch context stats: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "diff",
    description: "Show uncommitted diff (/diff [from] [to])",
    async run(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [from, to] = parts;
      try {
        const diffOptions: { from?: string; to?: string } = {};
        if (from) diffOptions.from = from;
        if (to) diffOptions.to = to;
        const diff = await ctx.client.getDiff(ctx.sessionId, diffOptions);
        if (!diff.trim()) {
          sysInfo(ctx, "No changes.");
          return;
        }
        sysInfo(ctx, diff);
      } catch (e) {
        sysError(
          ctx,
          `Diff failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "export",
    description:
      "Export session as markdown or JSON (/export [markdown|json] [--copy])",
    async run(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const format =
        parts[0] === "json" ? ("json" as const) : ("markdown" as const);
      const copy = parts.includes("--copy");

      try {
        const text = await ctx.client.exportSession(ctx.sessionId, { format });

        if (copy) {
          try {
            copyToClipboard(text);
            sysInfo(
              ctx,
              `Exported ${format} to clipboard (${text.length} chars).`,
            );
          } catch (e) {
            if (e instanceof ClipboardUnavailableError) {
              sysError(ctx, e.message);
            } else {
              sysError(ctx, "Failed to copy to clipboard.");
            }
          }
          return;
        }

        sysInfo(ctx, text);
      } catch (e) {
        sysError(
          ctx,
          `Export failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  },
  {
    name: "doctor",
    description: "Run system diagnostics",
    async run(_, ctx) {
      sysInfo(ctx, "Running diagnostics…");
      try {
        let config: ReturnType<typeof loadConfig>;
        try {
          config = loadConfig();
        } catch (e) {
          if (e instanceof MissingApiKeyError) {
            sysError(
              ctx,
              "API key not configured — run: iq config set ANTHROPIC_API_KEY sk-ant-...",
            );
          } else {
            sysError(
              ctx,
              `Config error: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          return;
        }
        const results = await runAllChecks(config);
        sysInfo(ctx, formatDoctorResults(results));
      } catch (e) {
        sysError(
          ctx,
          `Doctor failed: ${e instanceof Error ? e.message : String(e)}`,
        );
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

function slugFromFact(fact: string): string {
  const words = fact
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  const slug = words
    .join("-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug || "memory";
}

function formatMemoryRow(memory: {
  name: string;
  type: string;
  body: string;
}): string {
  const preview =
    memory.body.length > 60 ? `${memory.body.slice(0, 57)}...` : memory.body;
  return `  ${memory.name} (${memory.type}) - ${preview}`;
}

export function makeCommandRegistry(): CommandRegistry {
  return new CommandRegistry(commandDefs);
}
