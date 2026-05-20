import type { ContextStats } from "../client";

export function formatContextStats(stats: ContextStats): string {
  const used = stats.budget - stats.available;
  const pct = stats.budget > 0 ? used / stats.budget : 0;
  const filled = Math.max(0, Math.min(8, Math.round(pct * 8)));
  const bar = `${"▓".repeat(filled)}${"░".repeat(8 - filled)}`;
  const percent = `${Math.round(pct * 100)}%`;

  const rows = [
    `Context  ${bar}  ${percent}  ${formatK(used)} / ${formatK(stats.budget)} tokens`,
    `  messages     ${formatK(stats.messages)}`,
    `  system       ${formatK(stats.systemPrompt)}`,
    `  memory       ${formatK(stats.memory)}`,
    `  repo map     ${formatK(stats.repoMap)}`,
    `  available    ${formatK(stats.available)}`,
  ];

  if (stats.lastTurnTokens > 0) {
    rows.push(`  last turn     ${formatK(stats.lastTurnTokens)}`);
  }

  return rows.join("\n");
}

export function formatK(n: number): string {
  if (n < 1000) return String(n);
  return `${Math.round(n / 100) / 10}k`;
}
