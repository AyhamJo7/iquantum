import type { Phase } from "@iquantum/protocol";

export function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "requesting":
      return "Connecting";
    case "thinking":
      return "Thinking";
    case "planning":
      return "Planning";
    case "implementing":
      return "Implementing";
    case "validating":
      return "Validating";
  }
}
