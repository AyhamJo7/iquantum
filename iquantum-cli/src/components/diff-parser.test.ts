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
    expect(lines[0]).toEqual({
      type: "header",
      content: "--- a/foo.ts",
      lineNo: null,
    });
    expect(lines[1]).toEqual({
      type: "header",
      content: "+++ b/foo.ts",
      lineNo: null,
    });
    expect(lines[2]).toEqual({
      type: "hunk",
      content: "@@ -1,3 +1,3 @@",
      lineNo: null,
    });
    expect(lines[3]).toEqual({ type: "ctx", content: "context", lineNo: 1 });
    expect(lines[4]).toEqual({ type: "del", content: "old line", lineNo: 2 });
    expect(lines[5]).toEqual({
      type: "add",
      content: "new line",
      lineNo: null,
    });
  });

  it("strips leading space from context lines", () => {
    const lines = parseDiffLines(" hello world");
    expect(lines[0]).toEqual({
      type: "ctx",
      content: "hello world",
      lineNo: null,
    });
  });

  it("treats lines without a leading sigil as context", () => {
    const lines = parseDiffLines("no sigil");
    expect(lines[0]).toEqual({
      type: "ctx",
      content: "no sigil",
      lineNo: null,
    });
  });

  it("handles empty patch", () => {
    const lines = parseDiffLines("");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.type).toBe("ctx");
  });

  it("tracks original line numbers across deletions and context", () => {
    const lines = parseDiffLines(
      ["@@ -10,3 +10,4 @@", " keep", "-old", "+new", " next"].join("\n"),
    );

    expect(lines.map((line) => line.lineNo)).toEqual([null, 10, 11, null, 12]);
  });
});
