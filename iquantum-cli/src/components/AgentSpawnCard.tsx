import { Box, Text } from "ink";
import { BORDERS, STATUS_COLORS } from "./theme";

export interface AgentSpawnCardProps {
  name: string;
  sessionId: string;
}

export function AgentSpawnCard({ name, sessionId }: AgentSpawnCardProps) {
  return (
    <Box flexDirection="column" marginY={1} {...BORDERS.success}>
      <Text color={STATUS_COLORS.success}>spawned agent</Text>
      <Text>
        {name}
        {" -> "}
        {sessionId}
      </Text>
    </Box>
  );
}
