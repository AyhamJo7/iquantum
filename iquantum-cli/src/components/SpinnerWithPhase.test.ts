import { describe, expect, it } from "vitest";
import { phaseLabel } from "./spinner-phase";

describe("phaseLabel", () => {
  it("uses user-facing phase verbs", () => {
    expect(phaseLabel("requesting")).toBe("Connecting");
    expect(phaseLabel("thinking")).toBe("Thinking");
    expect(phaseLabel("planning")).toBe("Planning");
    expect(phaseLabel("implementing")).toBe("Implementing");
    expect(phaseLabel("validating")).toBe("Validating");
  });
});
