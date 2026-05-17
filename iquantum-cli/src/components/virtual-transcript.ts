import type { TranscriptItem } from "@iquantum/ui-core";

export function visibleTranscriptWindow(
  items: TranscriptItem[],
  maxVisibleItems: number,
): TranscriptItem[] {
  return items.slice(-Math.max(1, maxVisibleItems));
}
