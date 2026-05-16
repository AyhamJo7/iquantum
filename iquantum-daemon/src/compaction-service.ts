import { countTokens, needsCompaction } from "@iquantum/context-window";
import type { LLMMessage } from "@iquantum/types";
import {
  type ConversationCompleter,
  contentToText,
} from "./conversation-controller";
import { messagesSinceLastBoundary } from "./conversation-history";
import type { ConversationMessage, ConversationStore } from "./db/stores";

export interface CompactionStreams {
  publish(
    sessionId: string,
    frame: { type: "compact_boundary"; summary: string; tokenCount: number },
  ): void;
}

export interface CompactionServiceOptions {
  store: ConversationStore;
  completer: ConversationCompleter;
  streams: CompactionStreams;
  modelContextWindow: number;
  maxSummaryTokens?: number;
  now?: () => string;
  createId?: () => string;
  tokenCounter?: typeof countTokens;
}

export class CompactionService {
  readonly #store: ConversationStore;
  readonly #completer: ConversationCompleter;
  readonly #streams: CompactionStreams;
  readonly #modelContextWindow: number;
  readonly #maxSummaryTokens: number;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #tokenCounter: typeof countTokens;

  constructor(options: CompactionServiceOptions) {
    this.#store = options.store;
    this.#completer = options.completer;
    this.#streams = options.streams;
    this.#modelContextWindow = options.modelContextWindow;
    this.#maxSummaryTokens = options.maxSummaryTokens ?? 1200;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#tokenCounter = options.tokenCounter ?? countTokens;
  }

  async maybeCompact(sessionId: string): Promise<ConversationMessage | null> {
    const messages = messagesSinceLastBoundary(
      await this.#store.listAll(sessionId),
    );
    const tokenCount = this.#tokenCounter(messages);

    if (!needsCompaction(tokenCount, this.#modelContextWindow)) {
      return null;
    }

    return this.#compactMessages(sessionId, messages);
  }

  async compact(sessionId: string): Promise<ConversationMessage | null> {
    const messages = messagesSinceLastBoundary(
      await this.#store.listAll(sessionId),
    );

    if (messages.length === 0) {
      return null;
    }

    return this.#compactMessages(sessionId, messages);
  }

  async #compactMessages(
    sessionId: string,
    messages: ConversationMessage[],
  ): Promise<ConversationMessage> {
    let summary = "";

    for await (const delta of this.#completer.complete(
      compactionPrompt(messages),
      { maxTokens: this.#maxSummaryTokens },
    )) {
      summary += delta;
    }

    const blocks = [{ type: "text", text: summary }];
    const message: ConversationMessage = {
      id: this.#createId(),
      sessionId,
      role: "assistant",
      content: blocks,
      hasThinking: false,
      tokenCount: this.#tokenCounter([{ content: blocks }]),
      compactionBoundary: true,
      createdAt: this.#now(),
    };

    await this.#store.insert(message);
    this.#streams.publish(sessionId, {
      type: "compact_boundary",
      summary,
      tokenCount: message.tokenCount,
    });
    return message;
  }
}

function compactionPrompt(messages: ConversationMessage[]): LLMMessage[] {
  return [
    {
      role: "system",
      content:
        "Summarize this conversation for future continuation. Preserve user goals, decisions, constraints, completed work, and unresolved questions. Be concise but specific.",
    },
    ...messages.map((message) => ({
      role: message.role === "tool_result" ? ("user" as const) : message.role,
      content: contentToText(message),
    })),
  ];
}
