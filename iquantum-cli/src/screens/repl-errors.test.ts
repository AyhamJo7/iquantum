import { describe, expect, it } from "vitest";
import { DAEMON_DISCONNECTED_MESSAGE, formatREPLError } from "./repl-errors";

describe("formatREPLError", () => {
  it("normalizes Bun's missing Unix socket error into a daemon hint", () => {
    const error = new Error("Was there a typo in the url or port?");
    (error as NodeJS.ErrnoException).code = "FailedToOpenSocket";

    expect(formatREPLError(error)).toBe(DAEMON_DISCONNECTED_MESSAGE);
  });

  it("preserves non-daemon errors", () => {
    expect(formatREPLError(new Error("boom"))).toBe("boom");
  });
});
