import {
  type CompactionResult,
  type Compactor,
  FullCompactor,
  SnipCompactor,
} from "@iquantum/compaction";
import { countTokens } from "@iquantum/context-window";
import type { ContextStats, Message } from "@iquantum/types";
import type { ConversationMessage, ConversationStore } from "./db/stores";

export interface CompactionStreams {
  publish(
    sessionId: string,
    frame:
      | { type: "compact_boundary"; summary: string; tokenCount: number }
      | { type: "compaction"; savedTokens: number; strategy: "snip" | "full" },
  ): void;
}

export interface CompactionCompleter {
  complete(
    messages: import("@iquantum/types").LLMMessage[],
    options: { maxTokens: number },
  ): AsyncIterable<string>;
}

export interface CompactionServiceOptions {
  store: ConversationStore;
  completer: CompactionCompleter;
  streams: CompactionStreams;
  modelContextWindow: number;
  autoThreshold?: number;
  keepTurns?: number;
  maxSummaryTokens?: number;
  compactors?: Compactor[];
  now?: () => string;
  createId?: () => string;
  tokenCounter?: typeof countTokens;
}

export class CompactionService {
  readonly #store: ConversationStore;
  readonly #streams: CompactionStreams;
  readonly #modelContextWindow: number;
  readonly #compactors: Compactor[];
  readonly #fullCompactor: Compactor;
  readonly #tokenCounter: typeof countTokens;

  constructor(options: CompactionServiceOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#modelContextWindow = options.modelContextWindow;
    this.#tokenCounter = options.tokenCounter ?? countTokens;
    const fullCompactor =
      options.compactors?.find((compactor) => compactor.strategy === "full") ??
      new FullCompactor({
        llmRouter: options.completer,
        ...(options.maxSummaryTokens === undefined
          ? {}
          : { summaryTokens: options.maxSummaryTokens }),
        ...(options.keepTurns === undefined
          ? {}
          : { keepTurns: options.keepTurns }),
        ...(options.createId === undefined
          ? {}
          : { createId: options.createId }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    this.#fullCompactor = fullCompactor;
    this.#compactors = options.compactors ?? [
      new SnipCompactor({
        ...(options.autoThreshold === undefined
          ? {}
          : { threshold: options.autoThreshold }),
        ...(options.keepTurns === undefined
          ? {}
          : { keepTurns: options.keepTurns }),
        ...(options.createId === undefined
          ? {}
          : { createId: options.createId }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      fullCompactor,
    ];
  }

  async maybeCompact(sessionId: string): Promise<CompactionResult | null> {
    const messages = await this.#activeMessages(sessionId);
    const stats = this.#stats(messages);
    for (const compactor of this.#compactors) {
      if (!compactor.canApply(stats)) {
        continue;
      }

      const result = await compactor.compact(messages, stats);
      if (result.savedTokens <= 0) {
        continue;
      }

      await this.#persistResult(sessionId, result);
      return result;
    }

    return null;
  }

  async forceCompact(sessionId: string): Promise<CompactionResult> {
    const messages = await this.#activeMessages(sessionId);
    const stats = this.#stats(messages);

    if (messages.length === 0) {
      throw new Error(`Session ${sessionId} has no messages to compact`);
    }

    const result = await this.#fullCompactor.compact(messages, stats, {
      force: true,
    });
    await this.#persistResult(sessionId, result);
    return result;
  }

  async compact(sessionId: string): Promise<CompactionResult | null> {
    const messages = await this.#activeMessages(sessionId);
    if (messages.length === 0) {
      return null;
    }
    return this.forceCompact(sessionId);
  }

  async #persistResult(
    sessionId: string,
    result: CompactionResult,
  ): Promise<void> {
    await this.#store.insert(toConversationMessage(result.summary, result));
    this.#streams.publish(sessionId, {
      type: "compact_boundary",
      summary: result.summary.content,
      tokenCount: result.summary.tokenCount,
    });
    this.#streams.publish(sessionId, {
      type: "compaction",
      savedTokens: result.savedTokens,
      strategy: result.strategy,
    });
  }

  async #activeMessages(sessionId: string): Promise<Message[]> {
    const messages = await this.#store.listAll(sessionId);
    let lastBoundaryIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.compactionBoundary) {
        lastBoundaryIndex = index;
        break;
      }
    }
    return messages.slice(lastBoundaryIndex + 1).map(toMessage);
  }

  #stats(messages: Message[]): ContextStats {
    const tokenCount = this.#tokenCounter(
      messages.map((message) => ({ content: message.content })),
    );

    return {
      systemPrompt: 0,
      memory: 0,
      repoMap: 0,
      messages: tokenCount,
      lastTurnTokens: messages.at(-1)?.tokenCount ?? 0,
      budget: this.#modelContextWindow,
      available: Math.max(0, this.#modelContextWindow - tokenCount),
    };
  }
}

function toMessage(message: ConversationMessage): Message {
  return {
    id: message.id,
    sessionId: message.sessionId,
    taskId: null,
    role: message.role === "tool_result" ? "tool_result" : message.role,
    phase: "plan",
    model: null,
    content: message.content
      .map((block) =>
        typeof block.text === "string" ? block.text : JSON.stringify(block),
      )
      .join("\n"),
    hasThinking: message.hasThinking,
    tokenCount: message.tokenCount,
    compactionBoundary: message.compactionBoundary,
    compactionAnchor: message.compactionAnchor ?? false,
    ...(message.bodyCompressed === undefined
      ? {}
      : { bodyCompressed: message.bodyCompressed }),
    createdAt: message.createdAt,
  };
}

function toConversationMessage(
  message: Message,
  result: CompactionResult,
): ConversationMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    hasThinking: message.hasThinking,
    tokenCount: message.tokenCount,
    compactionBoundary: true,
    compactionAnchor: true,
    ...(result.compressedBody === undefined
      ? {}
      : { bodyCompressed: result.compressedBody }),
    createdAt: message.createdAt,
  };
}
