import type { AgentView } from "@iquantum/ui-core";
import { Box, Text } from "ink";
import { selectAgentDetail } from "./agent-card-format";
import { agentColors, STATUS_COLORS } from "./theme";

export { selectAgentDetail } from "./agent-card-format";

export interface AgentCardProps {
  agent: AgentView;
}

export function AgentCard({ agent }: AgentCardProps) {
  const color = agentColors[agent.colorIndex % agentColors.length];
  const progress =
    agent.turnIndex === undefined || agent.maxTurns === undefined
      ? ""
      : ` ${agent.turnIndex}/${agent.maxTurns}`;
  const detail = selectAgentDetail(agent);

  return (
    <Box
      flexDirection="column"
      borderLeft
      borderRight={false}
      borderTop={false}
      borderBottom={false}
      borderColor={color?.hex ?? STATUS_COLORS.info}
      paddingLeft={1}
    >
      <Text color={color?.hex ?? STATUS_COLORS.info}>
        {agent.name} {agent.phase ?? "idle"}
        {progress} {agent.status}
      </Text>
      {detail ? <Text dimColor>{detail}</Text> : null}
    </Box>
  );
}
