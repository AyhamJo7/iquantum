import type { ContextStats, Message } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import { FullCompactor } from "./full";

describe("FullCompactor", () => {
  it("applies above threshold", () => {
    const compactor = new FullCompactor({ llmRouter: router("summary") });

    expect(compactor.canApply(stats(96, 100))).toBe(true);
    expect(compactor.canApply(stats(94, 100))).toBe(false);
  });

  it("injects a summary and returns saved tokens", async () => {
    const compactor = new FullCompactor({
      llmRouter: router("compressed summary"),
      keepTurns: 2,
      createId: () => "summary-1",
      now: () => "2026-05-21T00:00:00.000Z",
    });

    const result = await compactor.compact(messages(8), stats(99, 100));

    expect(result.summary.content).toBe("compressed summary");
    expect(result.compressedBody).toBeUndefined();
    expect(result.savedTokens).toBeGreaterThanOrEqual(50);
  });
});

function router(text: string) {
  return {
    async *complete() {
      yield text;
    },
  };
}

function stats(used: number, budget: number): ContextStats {
  return {
    systemPrompt: 0,
    memory: 0,
    repoMap: 0,
    messages: used,
    lastTurnTokens: 1,
    budget,
    available: budget - used,
  };
}

function messages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    sessionId: "session-1",
    taskId: null,
    role: index % 2 === 0 ? "user" : "assistant",
    phase: "plan",
    model: null,
    content: `message ${index}`,
    hasThinking: false,
    tokenCount: 10,
    compactionBoundary: false,
    createdAt: `2026-05-21T00:00:0${index}.000Z`,
  }));
}
