import { describe, expect, it } from "vitest";
import {
  colorForSeverity,
  formatReviewFinding,
  formatReviewSummary,
} from "./review-card-format";

describe("review-card-format", () => {
  it("formats findings with severity and source location", () => {
    expect(
      formatReviewFinding({
        severity: "high",
        title: "Unsafe default",
        file: "src/auth.ts",
        line: 12,
        description: "The diff adds a bypass.",
        suggestion: "Require explicit configuration.",
      }),
    ).toMatchInlineSnapshot(`
      "[HIGH] Unsafe default
      src/auth.ts:12
      The diff adds a bypass.
      Suggestion: Require explicit configuration."
    `);
  });

  it("formats a compact completion summary", () => {
    expect(formatReviewSummary(1, "One issue found.", 1234)).toBe(
      "Review complete: 1 finding in 1.2s. One issue found.",
    );
  });

  it("maps severe findings to red", () => {
    expect(colorForSeverity("critical")).toBe("red");
    expect(colorForSeverity("high")).toBe("red");
  });
});
