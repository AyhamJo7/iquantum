import type { CompletionEvent, McpTool } from "@iquantum/types";
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

function createHarness(completions: string[]) {
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
  });

  return { controller, store, calls, frames };
}
