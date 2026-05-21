import type { Session } from "@iquantum/types";
import { describe, expect, it, vi } from "vitest";
import { AgentColorManager } from "./color-manager";
import { AgentRegistry } from "./registry";
import {
  AgentLimitError,
  AgentSpawner,
  type AgentSpawnerRepoMapCache,
  type AgentSpawnerSessionController,
} from "./spawner";

describe("AgentSpawner", () => {
  it("creates a child session, clones repo map, registers it, and starts work", async () => {
    const registry = new AgentRegistry();
    const repoMaps = new Map<string, unknown>([
      ["coordinator-1", { files: ["src/index.ts"] }],
    ]);
    const sessionController = fakeSessionController();
    const streams = { publish: vi.fn() };
    const spawner = new AgentSpawner({
      sessionController,
      repoMapCache: mapCache(repoMaps),
      memoryManager: {
        serializeForSession: vi.fn(async () => "memory block"),
      },
      agentRegistry: registry,
      colorManager: new AgentColorManager(),
      streams,
      maxAgents: 2,
    });

    const childId = await spawner.spawn("coordinator-1", {
      name: "api",
      prompt: "build api",
      inheritMemory: true,
      worktree: true,
      tools: ["file_read"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(childId).toBe("child-1");
    expect(sessionController.createSession).toHaveBeenCalledWith("/repo", {
      worktree: true,
      parentSessionId: "coordinator-1",
      agentName: "api",
      agentColor: "0",
      inheritedMemory: "memory block",
      allowedTools: ["file_read"],
      autoApprove: true,
      requireApproval: false,
    });
    expect(repoMaps.get("child-1")).toEqual({ files: ["src/index.ts"] });
    expect(repoMaps.get("child-1")).not.toBe(repoMaps.get("coordinator-1"));
    expect(registry.get("child-1")).toMatchObject({
      name: "api",
      coordinatorSessionId: "coordinator-1",
      status: "done",
    });
    expect(sessionController.startTask).toHaveBeenCalledWith(
      "child-1",
      "build api",
    );
    expect(sessionController.approve).toHaveBeenCalledWith("child-1", "plan-1");
    expect(streams.publish).toHaveBeenCalledWith("coordinator-1", {
      type: "agent_spawned",
      sessionId: "child-1",
      name: "api",
      colorIndex: 0,
      coordinatorSessionId: "coordinator-1",
    });
    expect(streams.publish).toHaveBeenCalledWith("coordinator-1", {
      type: "agent_done",
      sessionId: "child-1",
      name: "api",
      summary: "abc1234",
    });
  });

  it("enforces max agents per coordinator", async () => {
    const registry = new AgentRegistry();
    registry.register("child-existing", "api", 0, "coordinator-1");
    const spawner = new AgentSpawner({
      sessionController: fakeSessionController(),
      agentRegistry: registry,
      colorManager: new AgentColorManager(),
      maxAgents: 1,
    });

    await expect(
      spawner.spawn("coordinator-1", {
        name: "tests",
        prompt: "write tests",
        inheritMemory: false,
        worktree: true,
      }),
    ).rejects.toThrow(AgentLimitError);
  });

  it("decrements pending counter on createSession failure so a retry can succeed", async () => {
    const registry = new AgentRegistry();
    const sessionController = fakeSessionController();
    // First createSession call throws; second should succeed
    sessionController.createSession.mockRejectedValueOnce(
      new Error("docker unavailable"),
    );
    const spawner = new AgentSpawner({
      sessionController,
      agentRegistry: registry,
      colorManager: new AgentColorManager(),
      maxAgents: 1,
    });

    // First attempt fails
    await expect(
      spawner.spawn("coordinator-1", {
        name: "api",
        prompt: "build api",
        inheritMemory: false,
        worktree: true,
      }),
    ).rejects.toThrow("docker unavailable");

    // Pending counter must be back to 0, so second attempt is not blocked
    const childId = await spawner.spawn("coordinator-1", {
      name: "api",
      prompt: "build api",
      inheritMemory: false,
      worktree: true,
    });
    expect(childId).toBe("child-1");
  });

  it("is idempotent when killing a session that no longer exists", async () => {
    const registry = new AgentRegistry();
    const sessionController = fakeSessionController();
    sessionController.destroySession.mockRejectedValueOnce(
      Object.assign(new Error("Unknown session child-99"), {
        name: "SessionNotFoundError",
      }),
    );
    const spawner = new AgentSpawner({
      sessionController,
      agentRegistry: registry,
      colorManager: new AgentColorManager(),
    });

    await expect(spawner.kill("child-99", "cleanup")).resolves.toBeUndefined();
  });

  it("destroys child sessions and marks them killed", async () => {
    const registry = new AgentRegistry();
    registry.register("child-1", "api", 0, "coordinator-1");
    const sessionController = fakeSessionController();
    const streams = { publish: vi.fn() };
    const spawner = new AgentSpawner({
      sessionController,
      agentRegistry: registry,
      colorManager: new AgentColorManager(),
      streams,
    });

    await spawner.kill("child-1", "no longer needed");

    expect(sessionController.destroySession).toHaveBeenCalledWith("child-1");
    expect(registry.get("child-1")).toMatchObject({ status: "killed" });
    expect(streams.publish).toHaveBeenCalledWith("coordinator-1", {
      type: "agent_killed",
      sessionId: "child-1",
      name: "api",
      reason: "no longer needed",
    });
  });
});

function mapCache(map: Map<string, unknown>): AgentSpawnerRepoMapCache {
  return {
    get: (sessionId) => map.get(sessionId),
    set: (sessionId, repoMap) => map.set(sessionId, repoMap),
  };
}

function fakeSessionController(): AgentSpawnerSessionController & {
  createSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  startTask: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  destroySession: ReturnType<typeof vi.fn>;
  listCheckpoints: ReturnType<typeof vi.fn>;
} {
  return {
    getSession: vi.fn(async (sessionId: string) =>
      session({ id: sessionId, repoPath: "/repo" }),
    ),
    createSession: vi.fn(async () =>
      session({
        id: "child-1",
        parentSessionId: "coordinator-1",
        agentName: "api",
      }),
    ),
    startTask: vi.fn(async () => ({ id: "plan-1" })),
    approve: vi.fn(async () => undefined),
    listCheckpoints: vi.fn(async () => ({
      checkpoints: [{ commitHash: "abc1234" }],
    })),
    destroySession: vi.fn(async () => undefined),
  };
}

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
