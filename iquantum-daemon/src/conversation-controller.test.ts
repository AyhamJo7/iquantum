import type { CompletionEvent, McpTool } from "@iquantum/types";
import { WebToolExecutor } from "@iquantum/web-tools";
import { describe, expect, it, vi } from "vitest";
import type { PermissionChecker } from "./conversation-controller";
import { ConversationController } from "./conversation-controller";
import {
  InMemoryConversationStore,
  conversationMessage as message,
} from "./test-helpers";

const fixedNow = "2026-05-16T00:00:00.000Z";

describe("ConversationController", () => {
  it("stores multi-turn history and sends only conversation messages to the LLM", async () => {
    const harness = createHarness(["hello back", "second reply"]);

    await harness.controller.addMessage("session-1", "hello");
    await harness.controller.addMessage("session-1", "follow up");

    expect(harness.store.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(
      harness.calls[1]?.messages.map((message) => [
        message.role,
        message.content,
      ]),
    ).toEqual([
      ["user", "hello"],
      ["assistant", "hello back"],
      ["user", "follow up"],
    ]);
    expect(harness.frames).toEqual([
      { type: "phase_change", phase: "requesting" },
      { type: "phase_change", phase: "thinking" },
      { type: "token", delta: "hello back" },
      { type: "done" },
      { type: "phase_change", phase: "requesting" },
      { type: "phase_change", phase: "thinking" },
      { type: "token", delta: "second reply" },
      { type: "done" },
    ]);
  });

  it("excludes messages before the latest compaction boundary from API context", async () => {
    const harness = createHarness([]);
    harness.store.messages.push(
      message("old-user", "user", "old prompt"),
      message("old-assistant", "assistant", "old answer"),
      {
        ...message("summary", "assistant", "summary"),
        compactionBoundary: true,
      },
      message("new-user", "user", "new prompt"),
    );

    await expect(
      harness.controller.getMessagesForApi("session-1"),
    ).resolves.toMatchObject([{ id: "summary" }, { id: "new-user" }]);
  });

  it("cancel aborts the in-flight stream and emits done without the cancelled token", async () => {
    const frames: unknown[] = [];
    const store = new InMemoryConversationStore();
    const controller = new ConversationController({
      store,
      completer: {
        async *complete() {
          await Promise.resolve(); // yield control so cancel can run first
          yield "should-not-appear";
        },
      },
      streams: {
        publish(_sessionId, frame) {
          frames.push(frame);
        },
      },
      now: () => fixedNow,
      createId: () => "id-cancel",
      tokenCounter: () => 0,
    });

    // addMessage creates the AbortController synchronously before its first
    // await, so cancel() aborts it before the generator starts.
    const msgPromise = controller.addMessage("session-1", "hi");
    controller.cancel("session-1");
    await msgPromise;

    const tokenFrames = frames.filter(
      (f) => (f as { type: string }).type === "token",
    );
    expect(tokenFrames).toHaveLength(0);
    expect(frames).toContainEqual({ type: "done" });
  });

  it("keeps tool results in Anthropic-safe user-role context until structured blocks land", async () => {
    const harness = createHarness(["reply"]);
    harness.store.messages.push(
      message("tool-result", "tool_result", "diff applied"),
    );

    await harness.controller.addMessage("session-1", "continue");

    expect(harness.calls[0]?.messages).toMatchObject([
      { role: "user", content: "diff applied" },
      { role: "user", content: "continue" },
    ]);
  });

  it("prepends memory to the LLM system prompt when configured", async () => {
    const harness = createHarness(["reply"], {
      memoryManager: {
        store: {
          async upsertByName(memory) {
            return memory;
          },
        },
        async buildBlock() {
          return { text: "this project uses Bun", tokenCount: 5 };
        },
        async materialize() {
          return undefined;
        },
      },
    });

    await harness.controller.addMessage("session-1", "hello");

    const content = String(harness.calls[0]?.messages[0]?.content);
    expect(harness.calls[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("## Your Memory"),
    });
    expect(content).toContain("this project uses Bun");
    expect(harness.controller.getMemoryTokenCount("session-1")).toBe(5);
  });

  it("tracks system prompt wrapper tokens separately from memory tokens", async () => {
    const harness = createHarness(["reply"], {
      memoryManager: {
        store: {
          async upsertByName(memory) {
            return memory;
          },
        },
        async buildBlock() {
          return { text: "remembered context", tokenCount: 3 };
        },
        async materialize() {
          return undefined;
        },
      },
      tokenCounter(messages) {
        return String(messages[0]?.content ?? "").includes("Your Memory")
          ? 8
          : messages.length;
      },
    });

    await harness.controller.addMessage("session-1", "hello");

    expect(harness.controller.getMemoryTokenCount("session-1")).toBe(3);
    expect(harness.controller.getSystemPromptTokenCount("session-1")).toBe(5);
  });

  it("leaves the LLM prompt unchanged when memory is not configured", async () => {
    const harness = createHarness(["reply"]);

    await harness.controller.addMessage("session-1", "hello");

    expect(harness.calls[0]?.messages[0]).toMatchObject({
      role: "user",
      content: "hello",
    });
  });
});

describe("ConversationController — tool loop", () => {
  const fakeTool: McpTool = {
    name: "fs__read",
    description: "Read a file",
    inputSchema: { type: "object" },
  };

  function makeToolCompleter(
    events: CompletionEvent[][],
  ): (
    messages: unknown,
    tools: unknown,
    opts: unknown,
  ) => AsyncIterable<CompletionEvent> {
    let call = 0;
    return async function* () {
      const batch = events[call++] ?? [];
      for (const e of batch) yield e;
    };
  }

  it("executes tool call, appends result, and loops to final answer", async () => {
    const frames: unknown[] = [];
    const store = new InMemoryConversationStore();
    let nextId = 1;

    // Turn 1: LLM wants to call a tool
    // Turn 2: LLM gives final answer after seeing tool result
    const completeWithTools = makeToolCompleter([
      [
        {
          type: "tool_use",
          id: "call-1",
          name: "fs__read",
          input: { path: "/tmp/a" },
        },
      ],
      [{ type: "token", delta: "final answer" }],
    ]);

    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([fakeTool]),
      callTool: vi.fn().mockResolvedValue("file contents"),
    };
    const permissionChecker: PermissionChecker = {
      requestPermission: vi.fn().mockResolvedValue(true),
    };

    const controller = new ConversationController({
      store,
      completer: {
        async *complete() {
          yield "";
        },
        completeWithTools,
      },
      streams: { publish: (_s, f) => frames.push(f) },
      mcpClient,
      permissionChecker,
      now: () => fixedNow,
      createId: () => `id-${nextId++}`,
      tokenCounter: () => 0,
    });

    await controller.addMessage("session-1", "hello");

    // Stored messages: user, assistant (with tool_use blocks), tool_result, assistant (final)
    const roles = store.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool_result", "assistant"]);

    // Tool was called
    expect(mcpClient.callTool).toHaveBeenCalledWith("fs__read", {
      path: "/tmp/a",
    });

    // Final token was streamed
    expect(frames).toContainEqual({ type: "token", delta: "final answer" });
    expect(frames).toContainEqual({ type: "done" });
  });

  it("stores tool rejection when permission is denied", async () => {
    const store = new InMemoryConversationStore();
    let nextId = 1;

    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([fakeTool]),
      callTool: vi.fn(),
    };
    const permissionChecker: PermissionChecker = {
      requestPermission: vi.fn().mockResolvedValue(false),
    };

    const completeWithTools = makeToolCompleter([
      [{ type: "tool_use", id: "c1", name: "fs__read", input: {} }],
      [], // final turn with no tool calls
    ]);

    const controller = new ConversationController({
      store,
      completer: {
        async *complete() {
          yield "";
        },
        completeWithTools,
      },
      streams: { publish: () => {} },
      mcpClient,
      permissionChecker,
      now: () => fixedNow,
      createId: () => `id-${nextId++}`,
      tokenCounter: () => 0,
    });

    await controller.addMessage("session-1", "run tool");

    // Tool was NOT called because permission was denied
    expect(mcpClient.callTool).not.toHaveBeenCalled();

    // The tool_result message should contain the rejection text
    const toolResultMsg = store.messages.find((m) => m.role === "tool_result");
    const text = toolResultMsg?.content
      .map((b) =>
        typeof b.content === "string"
          ? b.content
          : typeof b.text === "string"
            ? b.text
            : "",
      )
      .join("");
    expect(text).toContain("rejected");
  });

  it("merges file tools into the tool loop and executes them without MCP", async () => {
    const frames: unknown[] = [];
    const store = new InMemoryConversationStore();
    const seenToolNames: string[][] = [];
    let nextId = 1;

    const completeWithTools = async function* (
      _messages: unknown,
      tools: McpTool[],
    ) {
      seenToolNames.push(tools.map((tool) => tool.name));
      if (seenToolNames.length === 1) {
        yield {
          type: "tool_use" as const,
          id: "file-call-1",
          name: "file_read",
          input: { path: "src/index.ts" },
        };
      } else {
        yield { type: "token" as const, delta: "done" };
      }
    };
    const permissionChecker: PermissionChecker = {
      requestPermission: vi.fn(),
    };

    const controller = new ConversationController({
      store,
      completer: {
        async *complete() {
          yield "";
        },
        completeWithTools,
      },
      streams: { publish: (_s, f) => frames.push(f) },
      fileTools: {
        tools: {
          getAll: () => [
            {
              name: "file_read",
              description: "read",
              inputSchema: { type: "object" },
              async execute(input: unknown) {
                return `read ${JSON.stringify(input)}`;
              },
            },
          ],
        } as never,
        sandbox: {
          exec: vi.fn(),
        },
      },
      permissionChecker,
      now: () => fixedNow,
      createId: () => `id-${nextId++}`,
      tokenCounter: () => 0,
    });

    await controller.addMessage("session-1", "read file");

    expect(seenToolNames[0]).toEqual(["file_read"]);
    expect(permissionChecker.requestPermission).not.toHaveBeenCalled();
    expect(frames).toContainEqual({
      type: "mcp_tool_call",
      server: "builtin",
      tool: "file_read",
      input: { path: "src/index.ts" },
    });
    expect(frames).toContainEqual({ type: "token", delta: "done" });
    const toolResult = store.messages.find(
      (message) => message.role === "tool_result",
    );
    expect(toolResult?.content).toMatchObject([
      {
        type: "tool_result",
        tool_use_id: "file-call-1",
        content: 'read {"path":"src/index.ts"}',
      },
    ]);
  });

  it("snapshots mutated builtin file tool paths", async () => {
    const store = new InMemoryConversationStore();
    const snapshotCalls: Array<{
      sessionId: string;
      turnIndex: number;
      filePaths: readonly string[];
    }> = [];
    let nextId = 1;

    const controller = new ConversationController({
      store,
      completer: {
        async *complete() {
          yield "";
        },
        async *completeWithTools(_messages, _tools) {
          if (snapshotCalls.length === 0) {
            yield {
              type: "tool_use" as const,
              id: "file-call-1",
              name: "file_write",
              input: { path: "src/index.ts" },
            };
          } else {
            yield { type: "token" as const, delta: "done" };
          }
        },
      },
      streams: { publish: () => {} },
      fileTools: {
        tools: {
          getAll: () => [
            {
              name: "file_write",
              description: "write",
              inputSchema: { type: "object" },
              mutates: true,
              async execute(input: unknown) {
                return `wrote ${JSON.stringify(input)}`;
              },
            },
          ],
        } as never,
        sandbox: { exec: vi.fn() },
      },
      snapshotStore: {
        async saveFilesFromSandbox(sessionId, turnIndex, filePaths) {
          snapshotCalls.push({ sessionId, turnIndex, filePaths });
        },
      },
      now: () => fixedNow,
      createId: () => `id-${nextId++}`,
      tokenCounter: () => 0,
    });

    await controller.addMessage("session-1", "write file");

    expect(snapshotCalls).toEqual([
      { sessionId: "session-1", turnIndex: 0, filePaths: ["src/index.ts"] },
    ]);
  });

  it("merges web tools into the tool loop and rate-limits web_search per session", async () => {
    const store = new InMemoryConversationStore();
    const seenToolNames: string[][] = [];
    let nextId = 1;

    const completeWithTools = async function* (
      _messages: unknown,
      tools: McpTool[],
    ) {
      seenToolNames.push(tools.map((tool) => tool.name));
      if (seenToolNames.length === 1) {
        yield {
          type: "tool_use" as const,
          id: "web-call-1",
          name: "web_search",
          input: { query: "latest bun" },
        };
      } else {
        yield { type: "token" as const, delta: "done" };
      }
    };
    const rateLimiter = {
      consume: vi.fn().mockResolvedValue({
        allowed: true,
        remaining: 9,
        resetAt: Date.now() + 60_000,
      }),
    };

    const controller = new ConversationController({
      store,
      completer: {
        async *complete() {
          yield "";
        },
        completeWithTools,
      },
      streams: { publish: () => {} },
      webTools: {
        getAll: () => [
          {
            name: "web_search",
            description: "search",
            inputSchema: { type: "object" },
            async execute(input: unknown) {
              return `searched ${JSON.stringify(input)}`;
            },
          },
        ],
      } as never,
      webSearchRateLimiter: rateLimiter,
      now: () => fixedNow,
      createId: () => `id-${nextId++}`,
      tokenCounter: () => 0,
    });

    await controller.addMessage("session-1", "search");

    expect(seenToolNames[0]).toEqual(["web_search"]);
    expect(rateLimiter.consume).toHaveBeenCalledWith("web_search:session-1", {
      limit: 10,
      windowMs: 60_000,
    });
    const toolResult = store.messages.find(
      (message) => message.role === "tool_result",
    );
    expect(toolResult?.content).toMatchObject([
      {
        type: "tool_result",
        tool_use_id: "web-call-1",
        content: 'searched {"query":"latest bun"}',
      },
    ]);
  });

  it("answers chat with Brave-backed web_search results through the real web tool executor", async () => {
    const store = new InMemoryConversationStore();
    const seenToolNames: string[][] = [];
    let nextId = 1;
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        web: {
          results: [
            {
              title: "Bun v1.2.3",
              url: "https://bun.sh/blog/bun-v1.2.3",
              description: "Bun v1.2.3 release notes",
            },
          ],
        },
      }),
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const completeWithTools = async function* (
        _messages: unknown,
        tools: McpTool[],
      ) {
        seenToolNames.push(tools.map((tool) => tool.name));
        if (seenToolNames.length === 1) {
          yield {
            type: "tool_use" as const,
            id: "web-call-1",
            name: "web_search",
            input: { query: "what is the latest version of bun?" },
          };
        } else {
          yield { type: "token" as const, delta: "Bun v1.2.3 is latest." };
        }
      };

      const controller = new ConversationController({
        store,
        completer: {
          async *complete() {
            yield "";
          },
          completeWithTools,
        },
        streams: { publish: () => {} },
        webTools: new WebToolExecutor({
          enabled: true,
          provider: "brave",
          braveApiKey: "brave-key",
        }),
        now: () => fixedNow,
        createId: () => `id-${nextId++}`,
        tokenCounter: () => 0,
      });

      await controller.addMessage(
        "session-1",
        "what is the latest version of bun?",
      );

      expect(seenToolNames[0]).toEqual(["web_fetch", "web_search"]);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        "q=what+is+the+latest+version+of+bun%3F",
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": "brave-key",
        },
      });
      const toolResult = store.messages.find(
        (message) => message.role === "tool_result",
      );
      expect(toolResult?.content).toMatchObject([
        {
          type: "tool_result",
          tool_use_id: "web-call-1",
          content:
            "1. Bun v1.2.3\n   https://bun.sh/blog/bun-v1.2.3\n   Bun v1.2.3 release notes",
        },
      ]);
      expect(store.messages.at(-1)?.content).toMatchObject([
        { type: "text", text: "Bun v1.2.3 is latest." },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to text loop when completer has no completeWithTools", async () => {
    const frames: unknown[] = [];
    const store = new InMemoryConversationStore();
    let nextId = 1;

    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([fakeTool]),
      callTool: vi.fn(),
    };

    const controller = new ConversationController({
      store,
      // no completeWithTools
      completer: {
        async *complete() {
          yield "fallback";
        },
      },
      streams: { publish: (_s, f) => frames.push(f) },
      mcpClient,
      now: () => fixedNow,
      createId: () => `id-${nextId++}`,
      tokenCounter: () => 0,
    });

    await controller.addMessage("session-1", "hello");
    expect(frames).toContainEqual({ type: "token", delta: "fallback" });
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });
});

function createHarness(
  completions: string[],
  options: Partial<
    ConstructorParameters<typeof ConversationController>[0]
  > = {},
) {
  let nextId = 1;
  const store = new InMemoryConversationStore();
  const calls: Array<{ messages: import("@iquantum/types").LLMMessage[] }> = [];
  const frames: unknown[] = [];
  const controller = new ConversationController({
    store,
    completer: {
      async *complete(messages) {
        calls.push({ messages });
        yield completions.shift() ?? "";
      },
    },
    streams: {
      publish(_sessionId, frame) {
        frames.push(frame);
      },
    },
    now: () => fixedNow,
    createId: () => `id-${nextId++}`,
    tokenCounter: (messages) => messages.length,
    ...options,
  });

  return { controller, store, calls, frames };
}
