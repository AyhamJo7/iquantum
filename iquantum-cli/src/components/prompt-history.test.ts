import { describe, expect, it } from "vitest";
import { navigateHistory } from "./prompt-history";

describe("navigateHistory", () => {
  it("walks backward and forward through prompt history", () => {
    expect(navigateHistory(["first", "second"], null, "up")).toEqual({
      index: 1,
      value: "second",
    });
    expect(navigateHistory(["first", "second"], 1, "up")).toEqual({
      index: 0,
      value: "first",
    });
    expect(navigateHistory(["first", "second"], 0, "down")).toEqual({
      index: 1,
      value: "second",
    });
    expect(navigateHistory(["first", "second"], 1, "down")).toEqual({
      index: null,
      value: "",
    });
  });
});
