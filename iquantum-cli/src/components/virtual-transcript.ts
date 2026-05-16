import type { TranscriptItem } from "../screens/repl-state";

export function visibleTranscriptWindow(
  items: TranscriptItem[],
  maxVisibleItems: number,
): TranscriptItem[] {
  return items.slice(-Math.max(1, maxVisibleItems));
}
