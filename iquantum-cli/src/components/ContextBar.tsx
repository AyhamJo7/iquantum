import { Box, Text } from "ink";
import type { ContextStats } from "../client";
import { formatK } from "./context-bar-format";

export { formatContextStats } from "./context-bar-format";

export interface ContextBarProps {
  stats: ContextStats;
}

export function ContextBar({ stats }: ContextBarProps) {
  const used = stats.budget - stats.available;
  const pct = stats.budget > 0 ? used / stats.budget : 0;
  const filled = Math.max(0, Math.min(8, Math.round(pct * 8)));
  const percent = `${Math.round(pct * 100)}%`;
  const barColor = filled >= 7 ? "red" : filled >= 5 ? "yellow" : undefined;

  const rows: Array<{ label: string; value: string }> = [
    { label: "messages", value: formatK(stats.messages) },
    { label: "system  ", value: formatK(stats.systemPrompt) },
    { label: "memory  ", value: formatK(stats.memory) },
    { label: "repo map", value: formatK(stats.repoMap) },
  ];

  if (stats.lastTurnTokens > 0) {
    rows.push({ label: "last turn", value: formatK(stats.lastTurnTokens) });
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold>Context </Text>
        <Text {...(barColor ? { color: barColor } : {})}>
          {"▓".repeat(filled)}
          {"░".repeat(8 - filled)}
        </Text>
        <Text dimColor>
          {" "}
          {percent} {formatK(used)} / {formatK(stats.budget)}
        </Text>
      </Box>
      {rows.map(({ label, value }) => (
        <Box key={label}>
          <Text dimColor> {label.padEnd(10)}</Text>
          <Text>{value}</Text>
        </Box>
      ))}
    </Box>
  );
}
