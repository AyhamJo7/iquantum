import type { AgentView } from "@iquantum/ui-core";

export function formatAgentRow(agent: AgentView): string {
  const progress =
    agent.turnIndex === undefined || agent.maxTurns === undefined
      ? "-"
      : `${agent.turnIndex}/${agent.maxTurns}`;

  return `${agent.name.padEnd(16)} ${(agent.phase ?? "-").padEnd(12)} ${progress.padEnd(7)} ${agent.status}`;
}
