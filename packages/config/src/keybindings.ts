import { readFileSync } from "node:fs";

export type KeybindingAction =
  | "compact"
  | "clear"
  | "status"
  | "restore"
  | "doctor"
  | "export"
  | "memory"
  | "review"
  | "diff"
  | "context"
  | "skills"
  | "hooks"
  | "history-prev"
  | "history-next"
  | `run:${string}`;

export interface KeybindingMap {
  [chord: string]: KeybindingAction;
}

const validActions = new Set<string>([
  "compact",
  "clear",
  "status",
  "restore",
  "doctor",
  "export",
  "memory",
  "review",
  "diff",
  "context",
  "skills",
  "hooks",
  "history-prev",
  "history-next",
]);

export function loadKeybindings(keybindingsFile: string): KeybindingMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keybindingsFile, "utf8"));
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const map: KeybindingMap = {};
  for (const [chord, action] of Object.entries(parsed)) {
    if (
      typeof chord === "string" &&
      chord.trim() &&
      typeof action === "string" &&
      isValidAction(action)
    ) {
      map[chord.toLowerCase()] = action;
    }
  }

  return map;
}

function isValidAction(action: string): action is KeybindingAction {
  return validActions.has(action) || /^run:[a-z0-9][a-z0-9-]*$/i.test(action);
}
