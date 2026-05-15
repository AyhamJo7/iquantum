import { describe, expect, it } from "vitest";
import {
  createRequestHandler,
  type DaemonSessions,
  type DaemonStreams,
} from "./server";
import { SessionNotFoundError } from "./session-controller";

describe("daemon request handler", () => {
  it("serves the session, task, and approval flow", async () => {
    const { sessions, calls } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
    });

    const created = await request(handler, "/sessions", {
      method: "POST",
      body: { repoPath: "/repo" },
    });
    const task = await request(handler, "/sessions/session-1/task", {
      method: "POST",
      body: { prompt: "add auth" },
    });
    const plan = await request(handler, "/sessions/session-1/plan");
    const approved = await request(handler, "/sessions/session-1/approve", {
      method: "POST",
    });
    const rejected = await request(handler, "/sessions/session-1/reject", {
      method: "POST",
      body: { feedback: "split it" },
    });

    expect(created?.status).toBe(201);
    expect(await created?.json()).toMatchObject({ id: "session-1" });
    expect(task?.status).toBe(202);
    expect(await task?.json()).toMatchObject({ id: "plan-1" });
    expect(await plan?.json()).toMatchObject({ id: "plan-1" });
    expect(await approved?.json()).toEqual({ ok: true });
    expect(await rejected?.json()).toMatchObject({ id: "plan-2" });
    expect(calls).toEqual([
      ["createSession", "/repo"],
      ["startTask", "session-1", "add auth"],
      ["currentPlan", "session-1"],
      ["approve", "session-1", undefined],
      ["reject", "session-1", "split it", undefined],
    ]);
  });

  it("validates request bodies and maps missing sessions to 404", async () => {
    const { sessions } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
    });

    const invalid = await request(handler, "/sessions", {
      method: "POST",
      body: {},
    });
    const missing = await request(handler, "/sessions/missing");

    expect(invalid?.status).toBe(400);
    expect(await invalid?.json()).toMatchObject({ error: "invalid_request" });
    expect(missing?.status).toBe(404);
    expect(await missing?.json()).toEqual({ error: "session_not_found" });
  });
});

function fakeSessions(): { sessions: DaemonSessions; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const plan = {
    id: "plan-1",
    sessionId: "session-1",
    content: "plan",
    status: "pending",
  };

  return {
    calls,
    sessions: {
      async createSession(repoPath) {
        calls.push(["createSession", repoPath]);
        return { id: "session-1", repoPath, status: "idle" };
      },
      async getSession(sessionId) {
        if (sessionId === "missing") {
          throw new SessionNotFoundError(sessionId);
        }

        return { id: sessionId, status: "idle" };
      },
      async destroySession(sessionId) {
        calls.push(["destroySession", sessionId]);
      },
      async startTask(sessionId, prompt) {
        calls.push(["startTask", sessionId, prompt]);
        return plan;
      },
      async currentPlan(sessionId) {
        calls.push(["currentPlan", sessionId]);
        return plan;
      },
      async approve(sessionId, planId) {
        calls.push(["approve", sessionId, planId]);
      },
      async reject(sessionId, feedback, planId) {
        calls.push(["reject", sessionId, feedback, planId]);
        return { ...plan, id: "plan-2", feedback };
      },
      async listCheckpoints(sessionId) {
        calls.push(["listCheckpoints", sessionId]);
        return [];
      },
      async restore(sessionId, hash) {
        calls.push(["restore", sessionId, hash]);
      },
    },
  };
}

function fakeStreams(): DaemonStreams {
  return {
    attach() {
      return () => undefined;
    },
    async handleMessage() {
      return undefined;
    },
  };
}

function request(
  handler: ReturnType<typeof createRequestHandler>,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response | undefined> {
  return handler(
    new Request(`http://localhost${pathname}`, {
      ...(options.method ? { method: options.method } : {}),
      ...(options.body === undefined
        ? {}
        : {
            body: JSON.stringify(options.body),
            headers: { "content-type": "application/json" },
          }),
    }),
    {
      upgrade() {
        return false;
      },
    },
  );
}
