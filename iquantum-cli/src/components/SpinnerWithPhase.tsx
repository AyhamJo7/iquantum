import type { Phase } from "@iquantum/protocol";
import { Text } from "ink";

export interface SpinnerWithPhaseProps {
  phase?: Phase;
}

export function SpinnerWithPhase({ phase }: SpinnerWithPhaseProps) {
  return phase ? <Text dimColor>⠋ {phase}</Text> : null;
}
