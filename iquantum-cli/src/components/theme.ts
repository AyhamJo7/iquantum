import type { Phase } from "@iquantum/protocol";

export const PHASE_COLORS = {
  planning: "blue",
  implementing: "magenta",
  validating: "yellow",
  requesting: "cyan",
  thinking: "cyan",
} as const satisfies Record<Phase, string>;

export const LOGO = "🧠";

export const STATUS_COLORS = {
  success: "green",
  warning: "yellow",
  error: "red",
  info: "cyan",
  muted: undefined,
} as const;

export const BORDERS = {
  success: { borderStyle: "round", borderColor: "green" },
  warning: { borderStyle: "round", borderColor: "yellow" },
  error: { borderStyle: "round", borderColor: "red" },
  info: { borderStyle: "round", borderColor: "cyan" },
} as const;

export const COPY = {
  phases: {
    planning: "planning",
    implementing: "implementing",
    validating: "validating",
    requesting: "requesting",
    thinking: "thinking",
  },
  phaseStrip: {
    planning: "plan",
    implementing: "implement",
    validating: "validate",
  },
  committed: "committed",
  error: "error",
  resumed: "resumed",
  compacted: "context compacted",
  hintIdle: "describe a task, or /help for commands",
} as const;
