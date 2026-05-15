import { describe, expect, it } from "vitest";
import {
  createRequestHandler,
  type DaemonSessions,
  type DaemonStreams,
} from "./server";
import { SessionNotFoundError } from "./session-controller";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";
const MISSING_SESSION_ID = "00000000-0000-0000-0000-000000000099";

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
    const task = await request(handler, `/sessions/${SESSION_ID}/task`, {
      method: "POST",
      body: { prompt: "add auth" },
    });
    const plan = await request(handler, `/sessions/${SESSION_ID}/plan`);
    const approved = await request(handler, `/sessions/${SESSION_ID}/approve`, {
      method: "POST",
    });
    const rejected = await request(handler, `/sessions/${SESSION_ID}/reject`, {
      method: "POST",
      body: { feedback: "split it" },
    });

    expect(created?.status).toBe(201);
    expect(await created?.json()).toMatchObject({ id: SESSION_ID });
    expect(task?.status).toBe(202);
    expect(await task?.json()).toMatchObject({ id: "plan-1" });
    expect(await plan?.json()).toMatchObject({ id: "plan-1" });
    expect(await approved?.json()).toEqual({ ok: true });
    expect(await rejected?.json()).toMatchObject({ id: "plan-2" });
    expect(calls).toEqual([
      ["createSession", "/repo"],
      ["startTask", SESSION_ID, "add auth"],
      ["currentPlan", SESSION_ID],
      ["approve", SESSION_ID, undefined],
      ["reject", SESSION_ID, "split it", undefined],
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
    const missing = await request(handler, `/sessions/${MISSING_SESSION_ID}`);

    expect(invalid?.status).toBe(400);
    expect(await invalid?.json()).toMatchObject({ error: "invalid_request" });
    expect(missing?.status).toBe(404);
    expect(await missing?.json()).toEqual({ error: "session_not_found" });
  });

  it("rejects malformed plan IDs and commit hashes before dispatch", async () => {
    const { sessions, calls } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
    });

    const invalidPlan = await request(
      handler,
      `/sessions/${SESSION_ID}/plans/not-a-uuid/approve`,
      { method: "POST" },
    );
    const invalidHash = await request(
      handler,
      `/sessions/${SESSION_ID}/checkpoints/not-a-hash/restore`,
      { method: "POST" },
    );

    expect(invalidPlan.status).toBe(404);
    expect(invalidHash.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

function fakeSessions(): { sessions: DaemonSessions; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const plan = {
    id: "plan-1",
    sessionId: SESSION_ID,
    content: "plan",
    status: "pending",
  };

  return {
    calls,
    sessions: {
      async createSession(repoPath) {
        calls.push(["createSession", repoPath]);
        return { id: SESSION_ID, repoPath, status: "idle" };
      },
      async getSession(sessionId) {
        if (sessionId === MISSING_SESSION_ID) {
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
  };
}

function request(
  handler: ReturnType<typeof createRequestHandler>,
  pathname: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
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
  );
}
