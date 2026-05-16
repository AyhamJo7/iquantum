import { describe, expect, it } from "vitest";
import { renderMarkdownToAnsi } from "./markdown";

describe("renderMarkdownToAnsi", () => {
  it("renders marked markdown with terminal emphasis", () => {
    const rendered = renderMarkdownToAnsi("**bold** and `code`");

    expect(rendered).toContain("[1mbold[22m");
    expect(rendered).toContain("[36mcode[39m");
  });

  it("returns the same string reference on repeated calls (cache hit)", () => {
    const first = renderMarkdownToAnsi("cached input");
    const second = renderMarkdownToAnsi("cached input");

    expect(first).toBe(second);
  });
});
