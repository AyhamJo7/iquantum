import { Box, Text } from "ink";
import { STATUS_COLORS } from "./theme";

export interface AgentErrorCardProps {
  name: string;
  error: string;
}

export function AgentErrorCard({ name, error }: AgentErrorCardProps) {
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
      <Text color={STATUS_COLORS.error}>agent failed</Text>
      <Text>
        {name}: {error}
      </Text>
      <Text dimColor>Use /agents for current worker status.</Text>
    </Box>
  );
}
