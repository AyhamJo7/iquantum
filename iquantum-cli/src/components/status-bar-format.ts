export function tokenBar(tokenCount: number, total = 32_000): string {
  const filled = Math.max(0, Math.min(8, Math.round((tokenCount / total) * 8)));
  return `${"▓".repeat(filled)}${"░".repeat(8 - filled)}`;
}

export function tokenCountLabel(tokenCount: number, total = 32_000): string {
  return `${formatThousands(tokenCount)} / ${formatThousands(total)}`;
}

function formatThousands(value: number): string {
  if (value < 1000) {
    return `${value}`;
  }

  return `${Math.round(value / 1000)}k`;
}
