import type { TranscriptItem } from "../screens/repl-state";
import { MessageList } from "./MessageList";
import { visibleTranscriptWindow } from "./virtual-transcript";

export interface VirtualMessageListProps {
  items: TranscriptItem[];
  streamingText: string;
  thinkingText: string;
  thinkingExpanded: boolean;
  maxVisibleItems?: number;
}

// The prototype keeps only the newest visible window mounted. TranscriptRow is
// memoized and keyed by persisted IDs, so old rows stay stable as new tokens
// stream while the viewport follows the bottom of the conversation.
export function VirtualMessageList({
  items,
  streamingText,
  thinkingText,
  thinkingExpanded,
  maxVisibleItems = 20,
}: VirtualMessageListProps) {
  return (
    <MessageList
      items={visibleTranscriptWindow(items, maxVisibleItems)}
      streamingText={streamingText}
      thinkingText={thinkingText}
      thinkingExpanded={thinkingExpanded}
    />
  );
}
