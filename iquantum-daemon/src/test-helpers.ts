import type { ConversationMessage, ConversationStore } from "./db/stores";

export class InMemoryConversationStore implements ConversationStore {
  readonly messages: ConversationMessage[];

  constructor(messages: ConversationMessage[] = []) {
    this.messages = [...messages];
  }

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

export function conversationMessage(
  id: string,
  role: ConversationMessage["role"],
  text: string,
  options: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id,
    sessionId: "session-1",
    role,
    content: [{ type: "text", text }],
    hasThinking: false,
    tokenCount: 1,
    compactionBoundary: false,
    createdAt: "2026-05-16T00:00:00.000Z",
    ...options,
  };
}
