import { describe, expect, it } from "vitest";
import { selectAgentDetail } from "./agent-card-format";
import { formatAgentRow } from "./agent-roster-format";

describe("formatAgentRow", () => {
  it("formats a running agent with phase and turn progress", () => {
    const row = formatAgentRow({
      sessionId: "child-1",
      name: "api",
      colorIndex: 0,
      phase: "implementing",
      turnIndex: 2,
      maxTurns: 5,
      status: "running",
    });
    expect(row).toContain("api");
    expect(row).toContain("implementing");
    expect(row).toContain("2/5");
    expect(row).toContain("running");
  });

  it("shows dash placeholders when phase and progress are absent", () => {
    const row = formatAgentRow({
      sessionId: "child-1",
      name: "api",
      colorIndex: 0,
      status: "running",
    });
    expect(row).toContain("api");
    expect(row).toContain("-");
    expect(row).toContain("running");
  });

  it("shows dash for progress when only turnIndex is present without maxTurns", () => {
    const row = formatAgentRow({
      sessionId: "child-1",
      name: "api",
      colorIndex: 0,
      turnIndex: 3,
      status: "running",
    });
    expect(row).toContain("-");
    expect(row).not.toContain("3/");
  });

  it("formats done status", () => {
    const row = formatAgentRow({
      sessionId: "child-1",
      name: "api",
      colorIndex: 0,
      status: "done",
    });
    expect(row).toContain("done");
  });

  it("formats failed status", () => {
    const row = formatAgentRow({
      sessionId: "child-2",
      name: "tests",
      colorIndex: 1,
      status: "failed",
    });
    expect(row).toContain("failed");
  });

  it("formats killed status", () => {
    const row = formatAgentRow({
      sessionId: "child-3",
      name: "docs",
      colorIndex: 2,
      status: "killed",
    });
    expect(row).toContain("killed");
  });

  it("pads name to consistent width for alignment", () => {
    const short = formatAgentRow({
      sessionId: "child-1",
      name: "api",
      colorIndex: 0,
      status: "running",
    });
    const long = formatAgentRow({
      sessionId: "child-1",
      name: "very-long-name-here",
      colorIndex: 0,
      status: "running",
    });
    expect(short.startsWith("api")).toBe(true);
    expect(long.startsWith("very-long-name-here")).toBe(true);
  });
});

describe("AgentCard detail selection", () => {
  it("prefers error over summary over lastMessage", () => {
    expect(
      selectAgentDetail({
        error: "boom",
        summary: "done",
        lastMessage: "hello",
      }),
    ).toBe("boom");
    expect(
      selectAgentDetail({
        error: undefined,
        summary: "done",
        lastMessage: "hello",
      }),
    ).toBe("done");
    expect(
      selectAgentDetail({
        error: undefined,
        summary: undefined,
        lastMessage: "hello",
      }),
    ).toBe("hello");
    expect(
      selectAgentDetail({
        error: undefined,
        summary: undefined,
        lastMessage: undefined,
      }),
    ).toBeUndefined();
  });
});
