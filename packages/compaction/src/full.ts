import type { ContextStats, LLMMessage, Message } from "@iquantum/types";
import {
  type CompactionLLMRouter,
  type CompactionResult,
  type Compactor,
  createCompactionSummaryMessage,
  isAnchorMessage,
  normalizeStats,
} from "./index";

export interface FullCompactorOptions {
  llmRouter: CompactionLLMRouter;
  summaryTokens?: number;
  threshold?: number;
  keepTurns?: number;
  now?: () => string;
  createId?: () => string;
}

export class FullCompactor implements Compactor {
  readonly strategy = "full" as const;
  readonly #llmRouter: CompactionLLMRouter;
  readonly #summaryTokens: number;
  readonly #threshold: number;
  readonly #keepTurns: number;
  readonly #now: () => string;
  readonly #createId: () => string;

  constructor(options: FullCompactorOptions) {
    this.#llmRouter = options.llmRouter;
    this.#summaryTokens = options.summaryTokens ?? 4000;
    this.#threshold = options.threshold ?? 0.95;
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
    options: { force?: boolean } = {},
  ): Promise<CompactionResult> {
    if (messages.length === 0) {
      throw new Error("Cannot compact an empty message list");
    }

    const range = this.#selectRange(messages, options.force === true);
    const replaced = messages.slice(range[0], range[1] + 1);
    const prompt = buildSummaryPrompt(replaced);
    let summaryText = "";

    for await (const delta of this.#llmRouter.complete(prompt, {
      maxTokens: this.#summaryTokens,
    })) {
      summaryText += delta;
    }

    const savedTokens = replaced.reduce(
      (total, message) => total + message.tokenCount,
      0,
    );
    const summary = createCompactionSummaryMessage({
      id: this.#createId(),
      sessionId: messages[0]?.sessionId ?? "",
      content: summaryText,
      tokenCount: Math.max(1, Math.ceil(summaryText.length / 4)),
      createdAt: this.#now(),
    });

    return {
      replacedRange: range,
      summary,
      savedTokens,
      strategy: this.strategy,
    };
  }

  #selectRange(messages: Message[], force: boolean): [number, number] {
    const firstCandidate = 1;
    const keepTurns = force ? Math.min(2, this.#keepTurns) : this.#keepTurns;
    const lastCandidate = messages.length - keepTurns - 1;

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

function buildSummaryPrompt(messages: Message[]): LLMMessage[] {
  return [
    {
      role: "system",
      content:
        "Summarize these pruned conversation turns for future continuation. Preserve user goals, architectural decisions, constraints, files changed, validation state, and unresolved work.",
    },
    {
      role: "user",
      content: messages
        .map(
          (message) =>
            `# ${message.role} (${message.phase}, ${message.createdAt})\n${message.content}`,
        )
        .join("\n\n"),
    },
  ];
}
