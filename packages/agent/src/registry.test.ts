import type { Session } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import { AgentRegistry, DuplicateAgentError } from "./registry";

describe("AgentRegistry", () => {
  it("registers, gets, lists, and deregisters agents", () => {
    const registry = new AgentRegistry();

    registry.register("child-1", "api", 0, "coordinator-1");
    registry.register("child-2", "tests", 1, "coordinator-1");
    registry.register("child-3", "docs", 2, "coordinator-2");

    expect(registry.get("child-1")).toMatchObject({
      sessionId: "child-1",
      name: "api",
      colorIndex: 0,
      coordinatorSessionId: "coordinator-1",
      status: "running",
    });
    expect(
      registry.list("coordinator-1").map((agent) => agent.sessionId),
    ).toEqual(["child-1", "child-2"]);

    registry.deregister("child-1");
    registry.deregister("child-1");

    expect(registry.get("child-1")).toBeUndefined();
    expect(
      registry.list("coordinator-1").map((agent) => agent.sessionId),
    ).toEqual(["child-2"]);
  });

  it("throws on duplicate registration", () => {
    const registry = new AgentRegistry();

    registry.register("child-1", "api", 0, "coordinator-1");

    expect(() =>
      registry.register("child-1", "api-copy", 1, "coordinator-1"),
    ).toThrow(DuplicateAgentError);
  });

  it("rebuilds entries from child sessions in the database", () => {
    const registry = new AgentRegistry();
    registry.register("old-child", "old", 0, "old-coordinator");

    registry.rebuildFromDb([
      session({ id: "coordinator-1" }),
      session({
        id: "child-1",
        parentSessionId: "coordinator-1",
        agentName: "api",
        agentColor: "3",
      }),
      session({
        id: "child-2",
        parentSessionId: "coordinator-2",
        agentName: "tests",
        agentColor: "1",
        status: "error",
      }),
    ]);

    expect(registry.get("old-child")).toBeUndefined();
    expect(registry.list("coordinator-1")).toEqual([
      {
        sessionId: "child-1",
        name: "api",
        colorIndex: 3,
        coordinatorSessionId: "coordinator-1",
        status: "running",
      },
    ]);
    expect(registry.list("coordinator-2")).toEqual([
      {
        sessionId: "child-2",
        name: "tests",
        colorIndex: 1,
        coordinatorSessionId: "coordinator-2",
        status: "failed",
      },
    ]);
  });
});

function session(overrides: Partial<Session>): Session {
  return {
    id: "session",
    status: "idle",
    repoPath: "/repo",
    containerId: "container",
    volumeId: "volume",
    config: {},
    mode: "piv",
    effort: "normal",
    worktreePath: null,
    worktreeBranch: null,
    startCheckpointHash: null,
    parentSessionId: null,
    agentName: null,
    agentColor: null,
    coordinatorMode: false,
    userId: null,
    orgId: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}
