import { countTokens as countTextTokens } from "@anthropic-ai/tokenizer";

export const COMPACTION_THRESHOLD = 0.87;

export interface ContextContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ContextWindowMessage {
  content: string | readonly ContextContentBlock[];
}

// Anthropic's local tokenizer is a rough estimator for modern Claude models;
// v2 uses it for thresholding, not billing. Exact API-side accounting remains
// the source of truth once a request is sent.
export function countTokens(messages: readonly ContextWindowMessage[]): number {
  return messages.reduce(
    (total, message) => total + countTextTokens(contentToText(message.content)),
    0,
  );
}

export function needsCompaction(
  tokenCount: number,
  modelContextWindow: number,
): boolean {
  if (!Number.isFinite(tokenCount) || tokenCount < 0) {
    throw new Error("tokenCount must be a non-negative finite number");
  }

  if (!Number.isFinite(modelContextWindow) || modelContextWindow <= 0) {
    throw new Error("modelContextWindow must be a positive finite number");
  }

  return tokenCount / modelContextWindow >= COMPACTION_THRESHOLD;
}

function contentToText(content: ContextWindowMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) =>
      typeof block.text === "string" ? block.text : JSON.stringify(block),
    )
    .join("\n");
}
