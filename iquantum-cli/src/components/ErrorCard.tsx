import { Box, Text } from "ink";
import { COPY, STATUS_COLORS } from "./theme";

export interface ErrorCardProps {
  message: string;
  hint?: string;
}

export function ErrorCard({
  message,
  hint = deriveHint(message),
}: ErrorCardProps) {
  return (
    <Box
      flexDirection="column"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={STATUS_COLORS.error}
      paddingLeft={1}
    >
      <Text color={STATUS_COLORS.error}>╸ {COPY.error}</Text>
      <Text>{message}</Text>
      {hint ? <Text dimColor>Run: {hint}</Text> : null}
    </Box>
  );
}

export function deriveHint(message: string): string | undefined {
  if (/daemon/i.test(message)) {
    return "iq daemon start";
  }

  if (/api.key|ANTHROPIC_API_KEY/i.test(message)) {
    return "iq config set ANTHROPIC_API_KEY <key>";
  }

  return undefined;
}
