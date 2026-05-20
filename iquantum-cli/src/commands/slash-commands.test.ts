import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillLoader } from "@iquantum/skills";
import type { REPLAction } from "@iquantum/ui-core";
import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "./registry";
import { makeCommandRegistry } from "./slash-commands";

function makeContext(overrides?: Partial<CommandContext>): CommandContext {
  const registry = makeCommandRegistry();
  const dispatched: REPLAction[] = [];
  const ctx: CommandContext = {
    client: {
      health: vi.fn().mockResolvedValue({ ok: true }),
      createSession: vi.fn(),
      getSession: vi.fn(),
      destroySession: vi.fn(),
      startTask: vi.fn(),
      currentPlan: vi.fn().mockResolvedValue(null),
      approve: vi.fn().mockResolvedValue(undefined),
      reject: vi.fn().mockResolvedValue(undefined),
      listCheckpoints: vi.fn().mockResolvedValue([]),
      restore: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn().mockResolvedValue(undefined),
      postPermission: vi.fn().mockResolvedValue(undefined),
      deleteMessages: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn().mockResolvedValue({ compacted: false, summary: null }),
      cancelStream: vi.fn().mockResolvedValue(undefined),
      listMcpTools: vi.fn().mockResolvedValue([]),
      listMemories: vi.fn().mockResolvedValue([]),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
      deleteMemory: vi.fn(),
      syncMemoryFromFile: vi.fn(),
      openStream: vi.fn(),
    } as unknown as CommandContext["client"],
    registry,
    sessionId: "session-1",
    dispatch: (action) => dispatched.push(action),
    tokenCount: 42,
    modelName: "test-model",
    editorModel: "test-editor-model",
    ...overrides,
  };
  return { ...ctx, dispatched } as CommandContext & {
    dispatched: REPLAction[];
  };
}

function getCmd(name: string) {
  const cmd = makeCommandRegistry().get(name);
  expect(cmd).toBeDefined();
  if (!cmd) throw new Error(`command /${name} not found`);
  return cmd;
}

describe("slash commands", () => {
  it("/status dispatches a system_message with session info", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };
    await getCmd("status").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({
      type: "system_message",
      level: "info",
    });
    const text = (ctx.dispatched[0] as { text: string }).text;
    expect(text).toContain("session-1");
    expect(text).toContain("42");
  });

  it("/model reports the effective configured models", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };
    await getCmd("model").run("", ctx);

    const text = (ctx.dispatched[0] as { text: string }).text;
    expect(text).toContain("test-model");
    expect(text).toContain("test-editor-model");
  });

  it("/clear dispatches clear_transcript on success", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };
    await getCmd("clear").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({ type: "clear_transcript" });
  });

  it("/reject with empty args dispatches system_message error", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };
    await getCmd("reject").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({
      type: "system_message",
      level: "error",
    });
  });

  it("/reject with feedback calls client.reject", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };
    await getCmd("reject").run("  too complex  ", ctx);

    expect(ctx.client.reject).toHaveBeenCalledWith("session-1", "too complex");
    expect(ctx.dispatched[0]).toMatchObject({
      type: "system_message",
      level: "info",
    });
  });

  it("/restore with no args lists checkpoints", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };
    await getCmd("restore").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({ type: "system_message" });
    const text = (ctx.dispatched[0] as { text: string }).text;
    expect(text).toContain("No checkpoints");
  });

  it("/restore with invalid hash dispatches error", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };
    await getCmd("restore").run("xyz!!", ctx);

    expect(ctx.dispatched[0]).toMatchObject({ level: "error" });
  });

  it("/mcp with no tools dispatches info message", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };
    await getCmd("mcp").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({
      type: "system_message",
      level: "info",
    });
    const text = (ctx.dispatched[0] as { text: string }).text;
    expect(text).toContain("IQUANTUM_MCP_SERVERS");
  });

  it("/mcp with tools lists them", async () => {
    const ctx = makeContext({
      client: {
        ...makeContext().client,
        listMcpTools: vi.fn().mockResolvedValue([
          {
            serverName: "fs",
            name: "read",
            description: "Read a file",
            inputSchema: {},
          },
        ]),
      },
    }) as CommandContext & { dispatched: REPLAction[] };

    await getCmd("mcp").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({
      type: "system_message",
      level: "info",
    });
    const text = (ctx.dispatched[0] as { text: string }).text;
    expect(text).toContain("fs/read");
    expect(text).toContain("Read a file");
  });

  it("/hooks lists loaded hooks", async () => {
    const ctx = makeContext({
      client: {
        ...makeContext().client,
        listHooks: vi.fn().mockResolvedValue([
          {
            name: "block-all",
            events: ["pre_apply_diff"],
            filePath: "/tmp/hooks/block-all.sh",
          },
        ]),
      },
    }) as CommandContext & { dispatched: REPLAction[] };

    await getCmd("hooks").run("", ctx);

    const text = (ctx.dispatched[0] as { text: string }).text;
    expect(text).toContain("block-all");
    expect(text).toContain("pre_apply_diff");
    expect(text).toContain("/tmp/hooks/block-all.sh");
  });

  it("/hooks reports no hooks when the client method is absent", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };

    await getCmd("hooks").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({
      type: "system_message",
      text: "No hooks loaded.",
      level: "info",
    });
  });

  it("/keybindings lists active keybindings", async () => {
    const ctx = makeContext({
      keybindings: {
        "ctrl+k ctrl+c": "compact",
        "ctrl+e": "export",
      },
    }) as CommandContext & { dispatched: REPLAction[] };

    await getCmd("keybindings").run("", ctx);

    const text = (ctx.dispatched[0] as { text: string }).text;
    expect(text).toContain("ctrl+k ctrl+c");
    expect(text).toContain("compact");
    expect(text).toContain("ctrl+e");
    expect(text).toContain("export");
  });

  it("/keybindings handles missing keybinding context", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };

    await getCmd("keybindings").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({
      type: "system_message",
      text: "No keybindings loaded.",
      level: "info",
    });
  });

  it("/review streams findings and a summary", async () => {
    const ctx = makeContext({
      client: {
        ...makeContext().client,
        async *reviewSession(sessionId, target) {
          expect(sessionId).toBe("session-1");
          expect(target).toEqual({ type: "commit", ref: "HEAD" });
          yield {
            severity: "high",
            title: "Unsafe default",
            file: "src/auth.ts",
            line: 12,
            description: "The diff adds a bypass.",
            suggestion: "Require explicit configuration.",
          };
          yield {
            type: "done",
            summary: "One issue found.",
            durationMs: 1200,
          };
        },
      },
    }) as CommandContext & { dispatched: REPLAction[] };

    await getCmd("review").run("commit HEAD", ctx);

    expect((ctx.dispatched[0] as { text: string }).text).toContain(
      "Reviewing commit HEAD",
    );
    expect(ctx.dispatched[1]).toMatchObject({
      type: "review_finding",
      finding: {
        severity: "high",
        title: "Unsafe default",
      },
    });
    expect((ctx.dispatched[2] as { text: string }).text).toContain(
      "Review complete: 1 finding",
    );
  });

  it("/review reports unsupported clients", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };

    await getCmd("review").run("", ctx);

    expect(ctx.dispatched[0]).toMatchObject({
      type: "system_message",
      level: "error",
      text: "Review is not supported by this daemon client.",
    });
  });

  it("/remember stores a project memory with a generated slug", async () => {
    const ctx = makeContext() as CommandContext & { dispatched: REPLAction[] };

    await getCmd("remember").run("  this project uses Bun not Node  ", ctx);

    expect(ctx.client.createMemory).toHaveBeenCalledWith({
      type: "project",
      name: "this-project-uses-bun-not",
      description: "(from /remember)",
      body: "this project uses Bun not Node",
      pinned: false,
    });
    expect(ctx.dispatched[0]).toMatchObject({ level: "info" });
  });

  it("/memory list displays saved memories", async () => {
    const ctx = makeContext({
      client: {
        ...makeContext().client,
        listMemories: vi.fn().mockResolvedValue([
          {
            id: "memory-1",
            userId: "local",
            orgId: null,
            type: "project",
            name: "uses-bun",
            description: "Runtime",
            body: "This project uses Bun.",
            pinned: false,
            createdAt: "2026-05-19T00:00:00.000Z",
            updatedAt: "2026-05-19T00:00:00.000Z",
          },
        ]),
      },
    }) as CommandContext & { dispatched: REPLAction[] };

    await getCmd("memory").run("list", ctx);

    const text = (ctx.dispatched[0] as { text: string }).text;
    expect(text).toContain("uses-bun (project)");
    expect(text).toContain("This project uses Bun.");
  });

  it("/memory forget and pin target memories by name", async () => {
    const baseClient = {
      ...makeContext().client,
      listMemories: vi.fn().mockResolvedValue([
        {
          id: "memory-1",
          userId: "local",
          orgId: null,
          type: "project",
          name: "uses-bun",
          description: "Runtime",
          body: "This project uses Bun.",
          pinned: false,
          createdAt: "2026-05-19T00:00:00.000Z",
          updatedAt: "2026-05-19T00:00:00.000Z",
        },
      ]),
      deleteMemory: vi.fn().mockResolvedValue(undefined),
      updateMemory: vi.fn().mockResolvedValue(undefined),
    };
    const forgetCtx = makeContext({ client: baseClient }) as CommandContext & {
      dispatched: REPLAction[];
    };
    const pinCtx = makeContext({ client: baseClient }) as CommandContext & {
      dispatched: REPLAction[];
    };

    await getCmd("memory").run("forget uses-bun", forgetCtx);
    await getCmd("memory").run("pin uses-bun", pinCtx);

    expect(baseClient.deleteMemory).toHaveBeenCalledWith("memory-1");
    expect(baseClient.updateMemory).toHaveBeenCalledWith("memory-1", {
      pinned: true,
    });
  });

  it("loads a custom JS skill, lists it in /skills, and runs it", async () => {
    const skillsDir = join(
      tmpdir(),
      `iq-skill-integration-${crypto.randomUUID()}`,
    );
    await mkdir(skillsDir, { recursive: true });
    await writeFile(
      join(skillsDir, "standup.js"),
      [
        "export default {",
        '  name: "standup",',
        '  description: "Create a standup note",',
        "  async run(args, ctx) {",
        '    ctx.dispatch({ type: "system_message", text: "standup:" + args, level: "info" });',
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const registry = makeCommandRegistry();
      for (const skill of await SkillLoader.load(skillsDir)) {
        registry.registerSkill(skill);
      }
      const ctx = makeContext({ registry }) as CommandContext & {
        dispatched: REPLAction[];
      };

      await registry.get("skills")?.run("", ctx);
      expect((ctx.dispatched[0] as { text: string }).text).toContain(
        "/standup",
      );

      await registry.get("standup")?.run("today", ctx);
      expect(ctx.dispatched[1]).toMatchObject({
        type: "system_message",
        text: "standup:today",
        level: "info",
      });
    } finally {
      await rm(skillsDir, { recursive: true, force: true });
    }
  });
});
