import { describe, expect, it } from "vitest";
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

function createHarness(completions: string[]) {
  let nextId = 1;
  const store = new InMemoryConversationStore();
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> =
    [];
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
