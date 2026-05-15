import { EventEmitter } from "node:events";
import type {
  PIVEngineEventMap,
  PIVEngineOptions,
  PIVStore,
} from "@iquantum/piv-engine";
import type { Plan, Session, SessionStatus } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import type { SessionStore } from "./db/stores";
import {
  type CurrentPlanStore,
  SessionController,
  type SessionEngine,
  type SessionGitManager,
} from "./session-controller";

describe("SessionController", () => {
  it("creates a persisted live session and wires a PIV engine", async () => {
    const harness = createHarness();

    const session = await harness.controller.createSession("/repo");

    expect(session).toMatchObject({
      id: "session-1",
      repoPath: "/repo",
      status: "idle",
      config: { testCommand: "bun test" },
    });
    expect(harness.createdSandboxes).toEqual([["session-1", "/repo"]]);
    expect(harness.engineOptions).toMatchObject({
      repoPath: "/repo",
      sessionId: "session-1",
      testCommand: "bun test",
      maxRetries: 3,
    });
    await expect(harness.controller.getSession("session-1")).resolves.toEqual(
      session,
    );
  });

  it("delegates plan actions to the live engine and reads the pending plan", async () => {
    const harness = createHarness();
    await harness.controller.createSession("/repo");

    await harness.controller.startTask("session-1", "add auth");
    const plan = await harness.controller.currentPlan("session-1");
    await harness.controller.approve("session-1");
    await harness.controller.reject("session-1", "split it", "plan-1");

    expect(plan?.id).toBe("plan-1");
    expect(harness.engineCalls).toEqual([
      ["startTask", "add auth"],
      ["approve", "plan-1"],
      ["reject", "plan-1", "split it"],
    ]);
  });
});

function createHarness() {
  const sessions = new Map<string, Session>();
  const plans = new Map<string, Plan>();
  const createdSandboxes: string[][] = [];
  const engineCalls: unknown[][] = [];
  let engineOptions: PIVEngineOptions | undefined;
  const plan = fakePlan();
  plans.set(plan.id, plan);

  const sessionStore: SessionStore = {
    async insert(session) {
      sessions.set(session.id, session);
    },
    async get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async delete(sessionId) {
      sessions.delete(sessionId);
    },
  };
  const pivStore: PIVStore & CurrentPlanStore = {
    async updateSessionStatus(sessionId, status: SessionStatus) {
      const session = sessions.get(sessionId);

      if (session) {
        session.status = status;
      }
    },
    async insertMessage() {
      return undefined;
    },
    async listMessagesBySession() {
      return [];
    },
    async insertPlan(nextPlan) {
      plans.set(nextPlan.id, nextPlan);
    },
    async getPlan(planId) {
      return plans.get(planId) ?? null;
    },
    async updatePlan(planId, updates) {
      const existing = plans.get(planId);

      if (!existing) {
        throw new Error("missing plan");
      }

      Object.assign(existing, updates);
      return existing;
    },
    async insertValidateRun() {
      return undefined;
    },
    async getCurrentPlan() {
      return plan;
    },
  };
  const gitManager: SessionGitManager = {
    async checkpoint() {
      throw new Error("not used");
    },
    async listCheckpoints() {
      return [];
    },
    async restore() {
      return undefined;
    },
  };

  const controller = new SessionController({
    sessionStore,
    pivStore,
    gitCheckpointStore: {
      async insert() {
        return undefined;
      },
      async listBySession() {
        return [];
      },
    },
    sandbox: {
      async createSandbox(sessionId, repoPath) {
        createdSandboxes.push([sessionId, repoPath]);
        return {
          sessionId,
          repoPath,
          containerName: `container-${sessionId}`,
          volumeName: `volume-${sessionId}`,
        };
      },
      async destroySandbox() {
        return undefined;
      },
      async exec() {
        throw new Error("not used");
      },
      async syncToHost() {
        return undefined;
      },
    },
    llmRouterFactory: () => ({
      async *complete() {
        yield "";
      },
    }),
    createEngine(options) {
      engineOptions = options;
      return fakeEngine(engineCalls);
    },
    createGitManager: () => gitManager,
    maxRetries: 3,
    loadTestCommand: async () => "bun test",
    now: () => "2026-05-15T00:00:00.000Z",
    createId: () => "session-1",
  });

  return {
    controller,
    createdSandboxes,
    engineCalls,
    get engineOptions() {
      return engineOptions;
    },
  };
}

function fakeEngine(calls: unknown[][]): SessionEngine {
  return {
    status: "idle",
    currentPlan: fakePlan(),
    events: new EventEmitter<PIVEngineEventMap>(),
    async startTask(prompt) {
      calls.push(["startTask", prompt]);
      return fakePlan();
    },
    async approve(planId) {
      calls.push(["approve", planId]);
    },
    async reject(planId, feedback) {
      calls.push(["reject", planId, feedback]);
      return fakePlan();
    },
  };
}

function fakePlan(): Plan {
  return {
    id: "plan-1",
    sessionId: "session-1",
    content: "plan",
    status: "pending",
    feedback: null,
    createdAt: "2026-05-15T00:00:00.000Z",
    approvedAt: null,
  };
}
