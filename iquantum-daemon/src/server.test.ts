import { describe, expect, it } from "vitest";
import { InvalidConversationCursorError } from "./db/stores";
import {
  createRequestHandler,
  type DaemonCompaction,
  type DaemonConversations,
  type DaemonMcpRegistry,
  type DaemonPermissions,
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
      ["createSession", "/repo", {}],
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

  it("rejects a relative repoPath with 400 before touching the session layer", async () => {
    const { sessions, calls } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
    });

    const response = await request(handler, "/sessions", {
      method: "POST",
      body: { repoPath: "relative/path/to/repo" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(calls).toEqual([]);
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

  it("accepts messages, paginates history, and clears conversation state", async () => {
    const { sessions } = fakeSessions();
    const { conversations, calls } = fakeConversations();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      conversations,
      compaction: fakeCompaction(),
    });

    const accepted = await request(
      handler,
      `/sessions/${SESSION_ID}/messages`,
      {
        method: "POST",
        body: { role: "user", content: "hello" },
      },
    );
    const history = await request(
      handler,
      `/sessions/${SESSION_ID}/messages?before=message-3&limit=2`,
    );
    const cleared = await request(handler, `/sessions/${SESSION_ID}/messages`, {
      method: "DELETE",
    });

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ accepted: true });
    expect(await history.json()).toEqual({
      messages: [{ id: "message-1" }, { id: "message-2" }],
      nextCursor: "message-1",
    });
    expect(cleared.status).toBe(204);
    expect(calls).toEqual([
      ["addMessage", SESSION_ID, "hello"],
      ["getMessages", SESSION_ID, { before: "message-3", limit: 2 }],
      ["clear", SESSION_ID],
    ]);
  });

  it("resolves permission requests through the permission endpoint", async () => {
    const { sessions } = fakeSessions();
    const { permissions, calls } = fakePermissions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      permissions,
    });

    const response = await request(
      handler,
      `/sessions/${SESSION_ID}/permission`,
      {
        method: "POST",
        body: { requestId: "request-1", approved: true },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual([
      ["resolvePermission", SESSION_ID, "request-1", true],
    ]);
  });

  it("returns 404 for message routes on missing sessions", async () => {
    const { sessions } = fakeSessions();
    const { conversations, calls } = fakeConversations();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      conversations,
      compaction: fakeCompaction(),
    });

    const missing = await request(
      handler,
      `/sessions/${MISSING_SESSION_ID}/messages`,
    );

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "session_not_found" });
    expect(calls).toEqual([]);
  });

  it("GET /mcp/tools returns empty array when no registry is configured", async () => {
    const { sessions } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
    });

    const response = await request(handler, "/mcp/tools");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("GET /mcp/tools returns tools from the registry", async () => {
    const { sessions } = fakeSessions();
    const mcpRegistry: DaemonMcpRegistry = {
      async listAllTools() {
        return [
          {
            serverName: "fs",
            name: "read_file",
            description: "Read",
            inputSchema: {},
          },
        ];
      },
    };
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      mcpRegistry,
    });

    const response = await request(handler, "/mcp/tools");
    expect(response.status).toBe(200);
    const tools = await response.json();
    expect(tools).toMatchObject([{ serverName: "fs", name: "read_file" }]);
  });

  it("returns 400 for a conversation cursor outside the session", async () => {
    const { sessions } = fakeSessions();
    const { conversations } = fakeConversations();
    conversations.getMessages = async () => {
      throw new InvalidConversationCursorError("foreign-message");
    };
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      conversations,
    });

    const response = await request(
      handler,
      `/sessions/${SESSION_ID}/messages?before=foreign-message`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_conversation_cursor",
    });
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
      async createSession(repoPath, options) {
        calls.push(["createSession", repoPath, options]);
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

function fakeConversations(): {
  conversations: DaemonConversations;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];

  return {
    calls,
    conversations: {
      async addMessage(sessionId, content) {
        calls.push(["addMessage", sessionId, content]);
      },
      async getMessages(sessionId, options) {
        calls.push(["getMessages", sessionId, options]);
        return {
          messages: [{ id: "message-1" }, { id: "message-2" }],
          nextCursor: "message-1",
        };
      },
      async clear(sessionId) {
        calls.push(["clear", sessionId]);
      },
      cancel(sessionId) {
        calls.push(["cancel", sessionId]);
      },
    },
  };
}

function fakeCompaction(): DaemonCompaction {
  return {
    async compact() {
      return null;
    },
  };
}

function fakePermissions(): {
  permissions: DaemonPermissions;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];

  return {
    calls,
    permissions: {
      resolvePermission(sessionId, requestId, approved) {
        calls.push(["resolvePermission", sessionId, requestId, approved]);
      },
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
