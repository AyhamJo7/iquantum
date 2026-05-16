import { describe, expect, it } from "vitest";
import { shortCommitHash, truncateCommitMessage } from "./commit-card-format";

describe("CommitCard", () => {
  it("shortens the displayed hash to seven characters", () => {
    expect(shortCommitHash("a3f8c12ff")).toBe("a3f8c12");
  });

  it("truncates long messages to fit an 80-column terminal", () => {
    const message = "x".repeat(90);

    expect(truncateCommitMessage(message, 80)).toHaveLength(72);
    expect(truncateCommitMessage(message, 80)).toMatch(/…$/);
  });
});
