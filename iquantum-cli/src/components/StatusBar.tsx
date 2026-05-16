import { Box, Text } from "ink";
import { tokenBar, tokenCountLabel } from "./status-bar-format";
import { STATUS_COLORS } from "./theme";

export interface StatusBarProps {
  version: string;
  modelName: string;
  tokenCount: number;
}

export function StatusBar({ version, modelName, tokenCount }: StatusBarProps) {
  const bar = tokenBar(tokenCount);
  const filled = bar.split("░", 1)[0]?.length ?? 0;
  const barColor =
    filled === 8
      ? STATUS_COLORS.error
      : filled >= 6
        ? STATUS_COLORS.warning
        : undefined;

  return (
    <Box marginTop={1}>
      <Text inverse bold>
        {" "}
        iq v{version}{" "}
      </Text>
      <Text dimColor> · {modelName} · </Text>
      <Text dimColor>{tokenCountLabel(tokenCount)} </Text>
      <Text {...(barColor ? { color: barColor } : {})}>{bar}</Text>
    </Box>
  );
}
