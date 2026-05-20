import { describe, expect, it } from "vitest";
import { ChordMatcher } from "./chord-matcher";

describe("ChordMatcher", () => {
  it("matches a single key immediately", () => {
    const matcher = new ChordMatcher({ "ctrl+e": "export" });

    expect(matcher.processKey("ctrl+e", 0)).toBe("export");
  });

  it("matches a two-key chord inside the window", () => {
    const matcher = new ChordMatcher({ "ctrl+k ctrl+c": "compact" }, 500);

    expect(matcher.processKey("ctrl+k", 0)).toBeNull();
    expect(matcher.processKey("ctrl+c", 250)).toBe("compact");
  });

  it("resets a partial chord after timeout", () => {
    const matcher = new ChordMatcher({ "ctrl+k ctrl+c": "compact" }, 500);

    expect(matcher.processKey("ctrl+k", 0)).toBeNull();
    expect(matcher.processKey("ctrl+c", 750)).toBeNull();
  });

  it("clears the buffer when the next key is not a chord prefix", () => {
    const matcher = new ChordMatcher({ "ctrl+k ctrl+c": "compact" }, 500);

    expect(matcher.processKey("ctrl+k", 0)).toBeNull();
    expect(matcher.processKey("ctrl+x", 100)).toBeNull();
    expect(matcher.processKey("ctrl+c", 150)).toBeNull();
  });
});
