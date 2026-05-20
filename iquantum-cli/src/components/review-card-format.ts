import type { ReviewFinding, ReviewSeverity } from "../client";

export function formatReviewFinding(finding: ReviewFinding): string {
  const location =
    finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return [
    `[${finding.severity.toUpperCase()}] ${finding.title}`,
    location,
    finding.description,
    `Suggestion: ${finding.suggestion}`,
  ].join("\n");
}

export function formatReviewSummary(
  findingCount: number,
  summary: string,
  durationMs?: number,
): string {
  const issueText =
    findingCount === 1 ? "1 finding" : `${findingCount} findings`;
  const durationText =
    durationMs === undefined ? "" : ` in ${(durationMs / 1000).toFixed(1)}s`;
  return `Review complete: ${issueText}${durationText}. ${summary}`;
}

export function colorForSeverity(severity: ReviewSeverity): string {
  switch (severity) {
    case "critical":
    case "high":
      return "red";
    case "medium":
      return "yellow";
    case "low":
      return "cyan";
  }
}
