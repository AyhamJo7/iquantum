import { describe, expect, it } from "vitest";
import { COMPACTION_THRESHOLD, countTokens, needsCompaction } from "./index";

describe("countTokens", () => {
  it("counts string and structured message content", () => {
    const count = countTokens([
      { content: "hello world" },
      {
        content: [
          { type: "text", text: "structured text" },
          { type: "tool_use", name: "read_file" },
        ],
      },
    ]);

    expect(count).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(countTokens([{ content: "hello world" }]));
  });
});

describe("needsCompaction", () => {
  it("trips at the 87 percent context threshold", () => {
    expect(COMPACTION_THRESHOLD).toBe(0.87);
    expect(needsCompaction(86, 100)).toBe(false);
    expect(needsCompaction(87, 100)).toBe(true);
  });

  it("rejects invalid counts and windows", () => {
    expect(() => needsCompaction(-1, 100)).toThrow();
    expect(() => needsCompaction(1, 0)).toThrow();
  });
});
