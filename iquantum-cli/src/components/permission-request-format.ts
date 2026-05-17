export function inputSummaryRows(input: unknown, width = 80): string[] {
  const maxLength = Math.max(0, Math.min(140, width - 2));

  if (Array.isArray(input)) {
    return input.map((item) =>
      truncateSummaryRow(summaryValue(item), maxLength),
    );
  }

  if (isPlainObject(input)) {
    return Object.entries(input).map(([key, value]) =>
      truncateSummaryRow(`${key}: ${JSON.stringify(value)}`, maxLength),
    );
  }

  if (typeof input === "string") {
    return [truncateSummaryRow(input, maxLength)];
  }

  return [];
}

function summaryValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value) ?? String(value);
}

export function truncateSummaryRow(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 1) {
    return "…".slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
