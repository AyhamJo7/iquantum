import type { Phase } from "@iquantum/protocol";
import { Box, Text } from "ink";
import { DISPLAY_PHASES } from "./phase-strip-format";
import { COPY, PHASE_COLORS, STATUS_COLORS } from "./theme";

export interface PIVPhaseStripProps {
  activePhase: Phase | null;
  completedPhases: Set<Phase>;
}

export function PIVPhaseStrip({
  activePhase,
  completedPhases,
}: PIVPhaseStripProps) {
  return (
    <Box marginY={1}>
      {DISPLAY_PHASES.map((phase, index) => (
        <Box key={phase}>
          {index > 0 ? <Text dimColor> · </Text> : null}
          <PhaseCell
            phase={phase}
            active={activePhase === phase}
            completed={completedPhases.has(phase)}
          />
        </Box>
      ))}
    </Box>
  );
}

function PhaseCell({
  phase,
  active,
  completed,
}: {
  phase: (typeof DISPLAY_PHASES)[number];
  active: boolean;
  completed: boolean;
}) {
  const label = COPY.phaseStrip[phase].toUpperCase();

  if (completed) {
    return (
      <Text bold color={STATUS_COLORS.success}>
        {label} ✓
      </Text>
    );
  }

  if (active) {
    return (
      <Text bold color={PHASE_COLORS[phase]}>
        {label} ▸
      </Text>
    );
  }

  return <Text dimColor>{label} ○</Text>;
}
