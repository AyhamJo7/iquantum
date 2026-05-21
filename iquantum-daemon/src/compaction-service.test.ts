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

  it("auto-compacts active history once the threshold is reached", async () => {
    const harness = createHarness(
      Array.from({ length: 12 }, (_, index) =>
        message(`message-${index}`, `content ${index}`),
      ),
    );

    const result = await harness.service.maybeCompact("session-1");

    expect(result).toMatchObject({
      strategy: "snip",
      savedTokens: expect.any(Number),
    });
    expect(harness.frames).toEqual([
      {
        type: "compact_boundary",
        summary: expect.stringContaining("compact_boundary"),
        tokenCount: expect.any(Number),
      },
      {
        type: "compaction",
        savedTokens: expect.any(Number),
        strategy: "snip",
      },
    ]);
    expect(harness.store.messages.at(-1)).toMatchObject({
      id: "summary-1",
      compactionBoundary: true,
    });
  });

  it("forceCompact always runs the full compactor", async () => {
    const harness = createHarness(
      Array.from({ length: 12 }, (_, index) =>
        message(`message-${index}`, `content ${index}`),
      ),
    );

    const result = await harness.service.forceCompact("session-1");

    expect(result.strategy).toBe("full");
    expect(result.compressedBody).toBeUndefined();
    expect(harness.completionCalls).toBe(1);
    expect(harness.frames.at(-1)).toEqual({
      type: "compaction",
      savedTokens: expect.any(Number),
      strategy: "full",
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
    keepTurns: 2,
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
