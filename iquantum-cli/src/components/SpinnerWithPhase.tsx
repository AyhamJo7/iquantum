import type { Phase } from "@iquantum/protocol";
import { Text } from "ink";
import { useEffect, useState } from "react";
import { phaseLabel } from "./spinner-phase";
import { PHASE_COLORS, STATUS_COLORS } from "./theme";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerWithPhaseProps {
  phase?: Phase;
  retryCount: number;
  maxRetries?: number;
}

export function SpinnerWithPhase({
  phase,
  retryCount,
  maxRetries = 3,
}: SpinnerWithPhaseProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Tracks time in the current phase, not total task time.
  useEffect(() => {
    if (!phase) {
      setElapsedSeconds(0);
      setFrameIndex(0);
      return;
    }

    const startedAt = Date.now();
    const timer = setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 50);

    return () => clearInterval(timer);
  }, [phase]);

  return phase ? (
    <Text color={PHASE_COLORS[phase]}>
      {frames[frameIndex]} {phaseLabel(phase)}{" "}
      {retryCount > 0 ? (
        <Text color={STATUS_COLORS.warning}>
          retry {retryCount} / {maxRetries}{" "}
        </Text>
      ) : null}
      {elapsedSeconds}s
    </Text>
  ) : null;
}
