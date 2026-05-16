import type { Phase } from "@iquantum/protocol";
import { COPY } from "./theme";

const DISPLAY_PHASES = [
  "planning",
  "implementing",
  "validating",
] as const satisfies readonly Phase[];

export function phaseStripText(
  activePhase: Phase | null,
  completedPhases: Set<Phase>,
): string {
  return DISPLAY_PHASES.map((phase) => {
    const label = COPY.phaseStrip[phase].toUpperCase();

    if (completedPhases.has(phase)) {
      return `${label} ✓`;
    }

    if (activePhase === phase) {
      return `${label} ▸`;
    }

    return `${label} ○`;
  }).join(" · ");
}

export { DISPLAY_PHASES };
