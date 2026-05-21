import type { AgentView } from "@iquantum/ui-core";
import { Box, Text } from "ink";
import { AgentCard } from "./AgentCard";
import { formatAgentRow } from "./agent-roster-format";
import { agentColors, STATUS_COLORS } from "./theme";

export interface AgentRosterProps {
  agents: AgentView[];
}

export function AgentRoster({ agents }: AgentRosterProps) {
  if (agents.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={STATUS_COLORS.info}>agents</Text>
      {agents.map((agent) => (
        <AgentRow key={agent.sessionId} agent={agent} />
      ))}
    </Box>
  );
}

function AgentRow({ agent }: { agent: AgentView }) {
  const color = agentColors[agent.colorIndex % agentColors.length];

  return (
    <Box flexDirection="column">
      <Text color={color?.hex ?? STATUS_COLORS.info}>
        {formatAgentRow(agent)}
      </Text>
      {agent.lastMessage || agent.error || agent.summary ? (
        <AgentCard agent={agent} />
      ) : null}
    </Box>
  );
}
