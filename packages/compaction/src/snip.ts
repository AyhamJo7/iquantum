import type { ContextStats, Message } from "@iquantum/types";
import {
  type CompactionResult,
  type Compactor,
  createCompactionSummaryMessage,
  isAnchorMessage,
  normalizeStats,
} from "./index";

export interface SnipCompactorOptions {
  threshold?: number;
  keepTurns?: number;
  now?: () => string;
  createId?: () => string;
}

export class SnipCompactor implements Compactor {
  readonly strategy = "snip" as const;
  readonly #threshold: number;
  readonly #keepTurns: number;
  readonly #now: () => string;
  readonly #createId: () => string;

  constructor(options: SnipCompactorOptions = {}) {
    this.#threshold = options.threshold ?? 0.8;
    this.#keepTurns = options.keepTurns ?? 8;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  canApply(stats: ContextStats): boolean {
    const { usedTokens, maxTokens } = normalizeStats(stats);
    return maxTokens > 0 && usedTokens / maxTokens > this.#threshold;
  }

  async compact(
    messages: Message[],
    _stats: ContextStats,
  ): Promise<CompactionResult> {
    if (messages.length === 0) {
      throw new Error("Cannot compact an empty message list");
    }

    const range = this.#selectRange(messages);
    const replaced = messages.slice(range[0], range[1] + 1);
    const savedTokens = replaced.reduce(
      (total, message) => total + message.tokenCount,
      0,
    );
    const summary = createCompactionSummaryMessage({
      id: this.#createId(),
      sessionId: messages[0]?.sessionId ?? "",
      content: JSON.stringify({
        type: "compact_boundary",
        replacedCount: replaced.length,
        savedTokens,
      }),
      tokenCount: Math.max(1, Math.ceil(savedTokens / 20)),
      createdAt: this.#now(),
    });

    return {
      replacedRange: range,
      summary,
      savedTokens,
      strategy: this.strategy,
    };
  }

  #selectRange(messages: Message[]): [number, number] {
    const firstCandidate = 1;
    const lastCandidate = messages.length - this.#keepTurns - 1;

    if (lastCandidate < firstCandidate) {
      return [firstCandidate, firstCandidate - 1];
    }

    const candidates = messages
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message, index }) =>
          index >= firstCandidate &&
          index <= lastCandidate &&
          !isAnchorMessage(message),
      );

    if (candidates.length === 0) {
      return [firstCandidate, firstCandidate - 1];
    }

    return [candidates[0]?.index ?? 0, candidates.at(-1)?.index ?? 0];
  }
}
