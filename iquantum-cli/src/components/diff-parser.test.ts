import { describe, expect, it } from "vitest";
import { parseDiffLines } from "./diff-parser";

describe("parseDiffLines", () => {
  it("parses additions, deletions, context, and hunk headers", () => {
    const patch = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-old line",
      "+new line",
    ].join("\n");

    const lines = parseDiffLines(patch);
    expect(lines[0]).toEqual({ type: "header", content: "--- a/foo.ts" });
    expect(lines[1]).toEqual({ type: "header", content: "+++ b/foo.ts" });
    expect(lines[2]).toEqual({ type: "hunk", content: "@@ -1,3 +1,3 @@" });
    expect(lines[3]).toEqual({ type: "ctx", content: "context" });
    expect(lines[4]).toEqual({ type: "del", content: "old line" });
    expect(lines[5]).toEqual({ type: "add", content: "new line" });
  });

  it("strips leading space from context lines", () => {
    const lines = parseDiffLines(" hello world");
    expect(lines[0]).toEqual({ type: "ctx", content: "hello world" });
  });

  it("treats lines without a leading sigil as context", () => {
    const lines = parseDiffLines("no sigil");
    expect(lines[0]).toEqual({ type: "ctx", content: "no sigil" });
  });

  it("handles empty patch", () => {
    const lines = parseDiffLines("");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.type).toBe("ctx");
  });
});
