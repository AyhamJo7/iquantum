import type { AgentRegistry } from "@iquantum/agent";
import { describe, expect, it } from "vitest";
import { AgentWaiter } from "./agent-waiter";

describe("AgentWaiter", () => {
  it("returns done result immediately when agent is already done", async () => {
    const registry = fakeRegistry({ "child-1": "done" });
    const sessions = fakeSessions({ "child-1": "abc1234" });
    const waiter = new AgentWaiter(registry, sessions, 5_000);

    const result = await waiter.wait("coordinator-1", "api", "child-1");

    expect(result).toEqual({
      name: "api",
      sessionId: "child-1",
      status: "done",
      summary: "completed",
      commitHash: "abc1234",
    });
  });

  it("returns failed result when agent status is failed", async () => {
    const registry = fakeRegistry({ "child-1": "failed" });
    const sessions = fakeSessions({});
    const waiter = new AgentWaiter(registry, sessions, 5_000);

    const result = await waiter.wait("coordinator-1", "api", "child-1");

    expect(result).toMatchObject({
      status: "failed",
      summary: "failed",
    });
  });

  it("maps killed status to failed result with summary 'killed'", async () => {
    const registry = fakeRegistry({ "child-1": "killed" });
    const sessions = fakeSessions({});
    const waiter = new AgentWaiter(registry, sessions, 5_000);

    const result = await waiter.wait("coordinator-1", "api", "child-1");

    expect(result).toMatchObject({
      status: "failed",
      summary: "killed",
    });
  });

  it("returns deregistered immediately without waiting for timeout", async () => {
    const registry = fakeRegistry({});
    const sessions = fakeSessions({});
    const waiter = new AgentWaiter(registry, sessions, 60_000);

    const start = Date.now();
    const result = await waiter.wait("coordinator-1", "api", "child-missing");
    const elapsed = Date.now() - start;

    expect(result).toMatchObject({ status: "failed", summary: "deregistered" });
    expect(elapsed).toBeLessThan(500);
  });

  it("resolves when status transitions from running to done mid-poll", async () => {
    let callCount = 0;
    const registry = {
      get(sessionId: string) {
        if (sessionId !== "child-1") return undefined;
        callCount += 1;
        return {
          sessionId: "child-1",
          name: "api",
          colorIndex: 0,
          coordinatorSessionId: "coordinator-1",
          status: callCount >= 2 ? ("done" as const) : ("running" as const),
        };
      },
    } as unknown as AgentRegistry;
    const sessions = fakeSessions({ "child-1": "abc999" });
    const waiter = new AgentWaiter(registry, sessions, 5_000);

    const result = await waiter.wait("coordinator-1", "api", "child-1");

    expect(result).toMatchObject({ status: "done", summary: "completed" });
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("times out and returns failed when agent never completes", async () => {
    const registry = fakeRegistry({ "child-1": "running" });
    const sessions = fakeSessions({});
    const waiter = new AgentWaiter(registry, sessions, 50);

    const result = await waiter.wait("coordinator-1", "api", "child-1");

    expect(result).toMatchObject({
      status: "failed",
      summary: expect.stringContaining("timed out"),
    });
  });
});

function fakeRegistry(statuses: Record<string, string>): AgentRegistry {
  return {
    get(sessionId: string) {
      const status = statuses[sessionId];
      if (!status) return undefined;
      return {
        sessionId,
        name: sessionId,
        colorIndex: 0,
        coordinatorSessionId: "coordinator-1",
        status: status as "running" | "done" | "failed" | "killed",
      };
    },
  } as unknown as AgentRegistry;
}

function fakeSessions(commitHashes: Record<string, string>): {
  listCheckpoints: (
    sessionId: string,
    options: { limit: number },
  ) => Promise<{ checkpoints: Array<{ commitHash: string }> }>;
} {
  return {
    async listCheckpoints(sessionId) {
      const hash = commitHashes[sessionId];
      return {
        checkpoints: hash ? [{ commitHash: hash }] : [],
      };
    },
  };
}
