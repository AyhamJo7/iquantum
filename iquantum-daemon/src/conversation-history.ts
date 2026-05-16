import type { ConversationMessage } from "./db/stores";

export function messagesSinceLastBoundary(
  messages: ConversationMessage[],
): ConversationMessage[] {
  const boundaryIndex = lastCompactionBoundaryIndex(messages);
  return boundaryIndex === -1 ? messages : messages.slice(boundaryIndex);
}

function lastCompactionBoundaryIndex(messages: ConversationMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.compactionBoundary) {
      return index;
    }
  }

  return -1;
}
