import { Box, Text } from "ink";

export interface StatusBarProps {
  modelName: string;
  sessionId: string;
  tokenCount: number;
  mode: string;
}

export function StatusBar({
  modelName,
  sessionId,
  tokenCount,
  mode,
}: StatusBarProps) {
  return (
    <Box borderStyle="single" borderLeft={false} borderRight={false}>
      <Text dimColor>
        {modelName} · session {sessionId.slice(0, 8)} · {tokenCount} tokens ·{" "}
        {mode}
      </Text>
    </Box>
  );
}
