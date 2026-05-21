import type { ContextStats, Message } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import { SnipCompactor } from "./snip";

describe("SnipCompactor", () => {
  it("does not apply below threshold", () => {
    const compactor = new SnipCompactor({ threshold: 0.8 });

    expect(compactor.canApply(stats(79, 100))).toBe(false);
  });

  it("applies above threshold and removes the middle segment", async () => {
    const compactor = new SnipCompactor({
      threshold: 0.8,
      keepTurns: 2,
      createId: () => "summary-1",
      now: () => "2026-05-21T00:00:00.000Z",
    });

    const result = await compactor.compact(messages(8), stats(90, 100));

    expect(compactor.canApply(stats(90, 100))).toBe(true);
    expect(result.replacedRange).toEqual([1, 5]);
    expect(result.summary.compactionBoundary).toBe(true);
  });

  it("does not include anchor messages in the replaced range selection", async () => {
    const compactor = new SnipCompactor({ keepTurns: 2 });
    const seed = messages(8);
    const anchored = seed[1];
    if (!anchored) throw new Error("expected seed message");
    seed[1] = { ...anchored, compactionAnchor: true };

    const result = await compactor.compact(seed, stats(90, 100));

    expect(result.replacedRange).toEqual([2, 5]);
  });

  it("preserves the last N turns", async () => {
    const compactor = new SnipCompactor({ keepTurns: 3 });

    const result = await compactor.compact(messages(10), stats(90, 100));

    expect(result.replacedRange[1]).toBe(6);
  });

  it("calculates saved tokens from replaced messages", async () => {
    const compactor = new SnipCompactor({ keepTurns: 2 });

    const result = await compactor.compact(messages(8), stats(90, 100));

    expect(result.savedTokens).toBe(50);
  });
});

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
