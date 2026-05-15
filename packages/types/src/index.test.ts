import { describe, expect, it } from "vitest";
import type { PIVPhase, SessionStatus } from "./index";

describe("@iquantum/types", () => {
  it("keeps phase and session status unions narrow", () => {
    const phase: PIVPhase = "plan";
    const status: SessionStatus = "planning";

    expect(phase).toBe("plan");
    expect(status).toBe("planning");
  });
});
