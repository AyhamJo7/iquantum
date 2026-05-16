import { describe, expect, it } from "vitest";
import { CompactionService } from "./compaction-service";
import type { ConversationMessage } from "./db/stores";
import { conversationMessage, InMemoryConversationStore } from "./test-helpers";

const fixedNow = "2026-05-16T00:00:00.000Z";

describe("CompactionService", () => {
  it("does nothing below the context threshold", async () => {
    const harness = createHarness([message("one", "hello")]);

    await expect(harness.service.maybeCompact("session-1")).resolves.toBeNull();
    expect(harness.completionCalls).toBe(0);
    expect(harness.store.messages).toHaveLength(1);
  });

  it("summarizes active history once the threshold is reached", async () => {
    const harness = createHarness([
      message("one", "hello"),
      message("two", "world"),
    ]);

    const summary = await harness.service.maybeCompact("session-1");

    expect(summary).toMatchObject({
      role: "assistant",
      compactionBoundary: true,
    });
    expect(harness.completionCalls).toBe(1);
    expect(harness.frames).toEqual([
      { type: "compact_boundary", summary: "compact summary" },
    ]);
    expect(harness.store.messages.at(-1)).toMatchObject({
      id: "summary-1",
      compactionBoundary: true,
    });
  });
});

function createHarness(seedMessages: ConversationMessage[]) {
  const store = new InMemoryConversationStore(seedMessages);
  let completionCalls = 0;
  const frames: unknown[] = [];
  const service = new CompactionService({
    store,
    completer: {
      async *complete() {
        completionCalls += 1;
        yield "compact summary";
      },
    },
    streams: {
      publish(_sessionId, frame) {
        frames.push(frame);
      },
    },
    modelContextWindow: 100,
    createId: () => "summary-1",
    now: () => fixedNow,
    tokenCounter: (messages) => messages.length * 50,
  });

  return {
    service,
    store,
    frames,
    get completionCalls() {
      return completionCalls;
    },
  };
}

function message(id: string, text: string): ConversationMessage {
  return conversationMessage(id, "user", text);
}
