import { Box, Text } from "ink";

export interface ThinkingBlockProps {
  text: string;
  expanded: boolean;
}

export function ThinkingBlock({ text, expanded }: ThinkingBlockProps) {
  return (
    <Box flexDirection="column">
      <Text dimColor>
        ∴ Thinking {expanded ? "[ctrl+o to collapse]" : "[ctrl+o to expand]"}
      </Text>
      {expanded ? <Text dimColor>{text}</Text> : null}
    </Box>
  );
}
