import { describe, expect, it } from "vitest";
import { ConversationController } from "./conversation-controller";
import type { ConversationMessage, ConversationStore } from "./db/stores";

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
      { type: "token", delta: "hello back" },
      { type: "done" },
      { type: "phase_change", phase: "requesting" },
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

class InMemoryConversationStore implements ConversationStore {
  readonly messages: ConversationMessage[] = [];

  async insert(message: ConversationMessage): Promise<void> {
    this.messages.push(message);
  }

  async listPage(
    sessionId: string,
    options: { before?: string; limit: number },
  ) {
    const sessionMessages = this.messages.filter(
      (message) => message.sessionId === sessionId,
    );
    const beforeIndex = options.before
      ? sessionMessages.findIndex((message) => message.id === options.before)
      : sessionMessages.length;
    const eligible = sessionMessages.slice(0, beforeIndex);
    const page = eligible.slice(-options.limit);
    return {
      messages: page,
      nextCursor:
        eligible.length > options.limit ? (page[0]?.id ?? null) : null,
    };
  }

  async listAll(sessionId: string): Promise<ConversationMessage[]> {
    return this.messages.filter((message) => message.sessionId === sessionId);
  }

  async deleteAll(sessionId: string): Promise<void> {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index]?.sessionId === sessionId) {
        this.messages.splice(index, 1);
      }
    }
  }
}

function message(
  id: string,
  role: ConversationMessage["role"],
  text: string,
): ConversationMessage {
  return {
    id,
    sessionId: "session-1",
    role,
    content: [{ type: "text", text }],
    hasThinking: false,
    tokenCount: 1,
    compactionBoundary: false,
    createdAt: fixedNow,
  };
}
