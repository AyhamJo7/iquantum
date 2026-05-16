export type HistoryDirection = "down" | "up";

export interface HistorySelection {
  index: number | null;
  value: string;
}

export function navigateHistory(
  history: string[],
  currentIndex: number | null,
  direction: HistoryDirection,
): HistorySelection | null {
  if (history.length === 0) {
    return null;
  }

  if (direction === "up") {
    const next = currentIndex === null ? history.length - 1 : currentIndex - 1;
    const bounded = Math.max(0, next);
    return {
      index: bounded,
      value: history[bounded] ?? "",
    };
  }

  if (currentIndex === null) {
    return null;
  }

  const next = currentIndex + 1;

  if (next >= history.length) {
    return { index: null, value: "" };
  }

  return {
    index: next,
    value: history[next] ?? "",
  };
}
