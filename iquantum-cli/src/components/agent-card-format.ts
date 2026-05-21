import type { AgentView } from "@iquantum/ui-core";

export function selectAgentDetail(
  agent: Pick<AgentView, "error" | "summary" | "lastMessage">,
): string | undefined {
  return agent.error ?? agent.summary ?? agent.lastMessage;
}
