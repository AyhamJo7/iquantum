import { describe, expect, it } from "vitest";
import { formatContextStats } from "./context-bar-format";

describe("ContextBar", () => {
  it("formats a token bar with percentage and breakdown rows", () => {
    expect(
      formatContextStats({
        systemPrompt: 100,
        memory: 200,
        repoMap: 300,
        messages: 400,
        lastTurnTokens: 50,
        budget: 2000,
        available: 1000,
      }),
    ).toMatchInlineSnapshot(`
      "Context  ▓▓▓▓░░░░  50%  1k / 2k tokens
        messages     400
        system       100
        memory       200
        repo map     300
        available    1k
        last turn     50"
    `);
  });
});
