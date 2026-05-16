import type { Phase } from "@iquantum/protocol";
import { Text } from "ink";
import { useEffect, useState } from "react";
import { phaseLabel } from "./spinner-phase";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerWithPhaseProps {
  phase?: Phase;
}

export function SpinnerWithPhase({ phase }: SpinnerWithPhaseProps) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

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
    <Text dimColor>
      {frames[frameIndex]} {phaseLabel(phase)}… {elapsedSeconds}s
    </Text>
  ) : null;
}
