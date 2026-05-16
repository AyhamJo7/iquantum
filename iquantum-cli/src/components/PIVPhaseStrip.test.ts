import type { Phase } from "@iquantum/protocol";
import { describe, expect, it } from "vitest";
import { phaseStripText } from "./phase-strip-format";

describe("PIVPhaseStrip", () => {
  it("renders all phases pending before work starts", () => {
    expect(phaseStripText(null, new Set<Phase>())).toBe(
      "PLAN ○ · IMPLEMENT ○ · VALIDATE ○",
    );
  });

  it("renders planning active", () => {
    expect(phaseStripText("planning", new Set<Phase>())).toBe(
      "PLAN ▸ · IMPLEMENT ○ · VALIDATE ○",
    );
  });

  it("renders implementing active after planning completes", () => {
    expect(phaseStripText("implementing", new Set<Phase>(["planning"]))).toBe(
      "PLAN ✓ · IMPLEMENT ▸ · VALIDATE ○",
    );
  });

  it("renders validating active after earlier phases complete", () => {
    expect(
      phaseStripText(
        "validating",
        new Set<Phase>(["planning", "implementing"]),
      ),
    ).toBe("PLAN ✓ · IMPLEMENT ✓ · VALIDATE ▸");
  });

  it("renders all phases complete after checkpointing", () => {
    expect(
      phaseStripText(
        null,
        new Set<Phase>(["planning", "implementing", "validating"]),
      ),
    ).toBe("PLAN ✓ · IMPLEMENT ✓ · VALIDATE ✓");
  });
});
