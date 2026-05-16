import { countTokens } from "@iquantum/context-window";
import type { LLMMessage } from "@iquantum/types";
import { messagesSinceLastBoundary } from "./conversation-history";
import type {
  ConversationMessage,
  ConversationPage,
  ConversationStore,
} from "./db/stores";

export interface ConversationCompleter {
  complete(
    messages: LLMMessage[],
    options: { maxTokens: number },
  ): AsyncIterable<string>;
}

export interface ConversationStreams {
  publish(
    sessionId: string,
    frame:
      | { type: "phase_change"; phase: "requesting" | "thinking" }
      | { type: "token"; delta: string }
      | { type: "error"; message: string }
      | { type: "done" },
  ): void;
}

export interface ConversationCompactor {
  maybeCompact(sessionId: string): Promise<unknown>;
}

export interface ConversationControllerOptions {
  store: ConversationStore;
  completer: ConversationCompleter;
  streams: ConversationStreams;
  compactor?: ConversationCompactor;
  maxResponseTokens?: number;
  now?: () => string;
  createId?: () => string;
  tokenCounter?: typeof countTokens;
}

export class ConversationController {
  readonly #store: ConversationStore;
  readonly #completer: ConversationCompleter;
  readonly #streams: ConversationStreams;
  readonly #compactor: ConversationCompactor | undefined;
  readonly #maxResponseTokens: number;
  readonly #now: () => string;
  readonly #createId: () => string;
  readonly #tokenCounter: typeof countTokens;
  #abortController: AbortController | null = null;

  constructor(options: ConversationControllerOptions) {
    this.#store = options.store;
    this.#completer = options.completer;
    this.#streams = options.streams;
    this.#compactor = options.compactor;
    this.#maxResponseTokens = options.maxResponseTokens ?? 2000;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#tokenCounter = options.tokenCounter ?? countTokens;
  }

  async addMessage(sessionId: string, content: string): Promise<void> {
    this.#abortController?.abort();
    const abortController = new AbortController();
    this.#abortController = abortController;

    await this.#compactor?.maybeCompact(sessionId);
    await this.#store.insert(this.#newMessage(sessionId, "user", content));

    this.#streams.publish(sessionId, {
      type: "phase_change",
      phase: "requesting",
    });

    try {
      const llmMessages = (await this.getMessagesForApi(sessionId)).map(
        toLLMMessage,
      );
      let response = "";
      this.#streams.publish(sessionId, {
        type: "phase_change",
        phase: "thinking",
      });

      for await (const delta of this.#completer.complete(llmMessages, {
        maxTokens: this.#maxResponseTokens,
      })) {
        if (abortController.signal.aborted) break;
        response += delta;
        this.#streams.publish(sessionId, { type: "token", delta });
      }

      if (!abortController.signal.aborted) {
        await this.#store.insert(
          this.#newMessage(sessionId, "assistant", response),
        );
        this.#streams.publish(sessionId, { type: "done" });
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      this.#streams.publish(sessionId, {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  cancel(sessionId: string): void {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#streams.publish(sessionId, { type: "done" });
  }

  async getMessages(
    sessionId: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<ConversationPage> {
    return this.#store.listPage(sessionId, {
      ...(options.before ? { before: options.before } : {}),
      limit: options.limit ?? 50,
    });
  }

  async getMessagesForApi(sessionId: string): Promise<ConversationMessage[]> {
    return messagesSinceLastBoundary(await this.#store.listAll(sessionId));
  }

  async getTokenCount(sessionId: string): Promise<number> {
    return this.#tokenCounter(await this.getMessagesForApi(sessionId));
  }

  async clear(sessionId: string): Promise<void> {
    await this.#store.deleteAll(sessionId);
  }

  #newMessage(
    sessionId: string,
    role: ConversationMessage["role"],
    content: string,
  ): ConversationMessage {
    const blocks = [{ type: "text", text: content }];

    return {
      id: this.#createId(),
      sessionId,
      role,
      content: blocks,
      hasThinking: false,
      tokenCount: this.#tokenCounter([{ content: blocks }]),
      compactionBoundary: false,
      createdAt: this.#now(),
    };
  }
}

function toLLMMessage(message: ConversationMessage): LLMMessage {
  return {
    // Real Anthropic tool results are user-role messages with tool_result
    // blocks; role:"tool" would be dropped by the Anthropic adapter.
    role: message.role === "tool_result" ? "user" : message.role,
    content: contentToText(message),
  };
}

export function contentToText(message: ConversationMessage): string {
  return message.content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}
