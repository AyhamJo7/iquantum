import type { KeybindingMap } from "@iquantum/config";
import { useInput } from "ink";
import { useMemo } from "react";
import { ChordMatcher } from "./chord-matcher";

export function useKeybindings(
  map: KeybindingMap,
  dispatch: (action: unknown) => void,
): void {
  const matcher = useMemo(() => new ChordMatcher(map), [map]);

  useInput((input, key) => {
    const normalized = normalizeKey(input, key);
    if (!normalized) return;

    const action = matcher.processKey(normalized, Date.now());
    if (action) {
      dispatch({ type: "run_command", command: action });
    }
  });
}

function normalizeKey(
  input: string,
  key: {
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    name?: string;
    return?: boolean;
    escape?: boolean;
    tab?: boolean;
  },
): string | null {
  if (key.return) return "return";
  if (key.escape) return "escape";
  if (key.tab) return "tab";

  const base = key.name ?? input;
  if (!base) return null;

  const parts: string[] = [];
  if (key.ctrl) parts.push("ctrl");
  if (key.meta) parts.push("meta");
  if (key.shift) parts.push("shift");
  parts.push(base.toLowerCase());
  return parts.join("+");
}
