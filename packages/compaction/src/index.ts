import type { ContextStats, LLMMessage, Message } from "@iquantum/types";

export interface CompactionResult {
  replacedRange: [number, number];
  summary: Message;
  savedTokens: number;
  compressedBody?: Buffer;
  strategy: "snip" | "full";
}

export interface Compactor {
  readonly strategy: "snip" | "full";
  canApply(stats: ContextStats): boolean;
  compact(
    messages: Message[],
    stats: ContextStats,
    options?: { force?: boolean },
  ): Promise<CompactionResult>;
}

export interface CompactionLLMRouter {
  complete(
    messages: LLMMessage[],
    options: { maxTokens: number },
  ): AsyncIterable<string>;
}

export interface CompactionStats {
  usedTokens: number;
  maxTokens: number;
}

export function normalizeStats(stats: ContextStats): CompactionStats {
  const usedTokens =
    stats.systemPrompt + stats.memory + stats.repoMap + stats.messages;
  const maxTokens = stats.budget;

  return { usedTokens, maxTokens };
}

export function isAnchorMessage(message: Message): boolean {
  if (message.compactionAnchor || message.compactionBoundary) {
    return true;
  }

  return message.content.includes('"type":"checkpoint_created"');
}

export function isCompactionBoundaryMessage(message: {
  compactionBoundary?: boolean;
}): boolean {
  return message.compactionBoundary === true;
}

export function createCompactionSummaryMessage(
  message: Omit<
    Message,
    | "taskId"
    | "role"
    | "phase"
    | "model"
    | "hasThinking"
    | "compactionBoundary"
    | "compactionAnchor"
  > & { taskId?: string | null },
): Message {
  return {
    id: message.id,
    sessionId: message.sessionId,
    taskId: message.taskId ?? null,
    role: "assistant",
    phase: "plan",
    model: null,
    content: message.content,
    hasThinking: false,
    tokenCount: message.tokenCount,
    compactionBoundary: true,
    compactionAnchor: true,
    createdAt: message.createdAt,
  };
}

export { FullCompactor } from "./full";
export { SnipCompactor } from "./snip";
