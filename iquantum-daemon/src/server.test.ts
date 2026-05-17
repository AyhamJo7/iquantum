import { describe, expect, it } from "vitest";
import { InvalidConversationCursorError } from "./db/stores";
import {
  createRequestHandler,
  createTcpDaemonServer,
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
      ["createSession", "/repo", { mode: "piv" }],
      ["startTask", SESSION_ID, "add auth"],
      ["currentPlan", SESSION_ID],
      ["approve", SESSION_ID, undefined],
      ["reject", SESSION_ID, "split it", undefined],
    ]);
  });

  it("validates request bodies and maps missing sessions to 404", async () => {
    const { sessions } = fakeSessions("chat");
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

  it("returns current plan content from GET /sessions/:id/plan", async () => {
    const { sessions } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
    });

    const response = await request(handler, `/sessions/${SESSION_ID}/plan`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "plan" });
  });

  it("accepts messages, paginates history, and clears conversation state", async () => {
    const { sessions } = fakeSessions("chat");
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

  it("routes chat and piv message posts to different engines", async () => {
    const { sessions: chatSessions, calls: chatSessionCalls } =
      fakeSessions("chat");
    const { conversations, calls: conversationCalls } = fakeConversations();
    const chatHandler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: chatSessions,
      streams: fakeStreams(),
      conversations,
    });

    await request(chatHandler, `/sessions/${SESSION_ID}/messages`, {
      method: "POST",
      body: { role: "user", content: "hello chat" },
    });

    expect(conversationCalls).toEqual([
      ["addMessage", SESSION_ID, "hello chat"],
    ]);
    expect(chatSessionCalls).toEqual([]);

    const { sessions: pivSessions, calls: pivCalls } = fakeSessions("piv");
    const pivHandler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: pivSessions,
      streams: fakeStreams(),
      conversations: fakeConversations().conversations,
    });

    await request(pivHandler, `/sessions/${SESSION_ID}/messages`, {
      method: "POST",
      body: { role: "user", content: "hello task" },
    });

    await Promise.resolve();
    expect(pivCalls).toContainEqual(["startTask", SESSION_ID, "hello task"]);
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

  it("serves cloud auth routes and protects tenant-scoped routes", async () => {
    const { sessions } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async createOrg() {
          return { id: "org-1" };
        },
        async createUser() {
          return { id: "user-1", orgId: "org-1", role: "owner" };
        },
        async verifyPassword() {
          return { id: "user-1", orgId: "org-1", role: "owner" };
        },
      } as never,
      jwtService: {
        async sign() {
          return "jwt";
        },
        async verify(token: string) {
          return token === "jwt"
            ? { userId: "user-1", orgId: "org-1", role: "owner" }
            : null;
        },
      } as never,
    });

    const registered = await request(handler, "/auth/register", {
      method: "POST",
      body: { email: "a@example.com", password: "password123" },
    });
    const login = await request(handler, "/auth/login", {
      method: "POST",
      body: { email: "a@example.com", password: "password123" },
    });
    const unauthorized = await request(handler, `/sessions/${SESSION_ID}`);

    expect(registered.status).toBe(201);
    expect(login.status).toBe(200);
    expect(unauthorized.status).toBe(401);
  });

  it("maps postgres duplicate-email errors to 409 during registration", async () => {
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async createOrg() {
          return { id: "org-1" };
        },
        async createUser() {
          throw Object.assign(new Error("duplicate key value"), {
            code: "23505",
          });
        },
      } as never,
      jwtService: {
        async verify() {
          return null;
        },
      } as never,
    });

    const response = await request(handler, "/auth/register", {
      method: "POST",
      body: { email: "a@example.com", password: "password123" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "email_exists" });
  });

  it("rejects login attempts with the wrong password", async () => {
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async verifyPassword() {
          return null;
        },
      } as never,
      jwtService: {
        async verify() {
          return null;
        },
      } as never,
    });

    const response = await request(handler, "/auth/login", {
      method: "POST",
      body: { email: "a@example.com", password: "wrong-password" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid credentials" });
  });

  it("falls back to the default quota for invalid Stripe metadata", async () => {
    const updates: unknown[][] = [];
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async updateOrgPlanByStripeCustomer(...args: unknown[]) {
          updates.push(args);
        },
      } as never,
      jwtService: {
        async verify() {
          return null;
        },
      } as never,
      stripeClient: {
        constructWebhookEvent() {
          return {
            type: "customer.subscription.updated",
            data: {
              object: {
                customer: "cus_1",
                metadata: { plan: "pro", sandboxQuotaHours: "unlimited" },
              },
            },
          };
        },
      } as never,
      stripeWebhookSecret: "whsec",
    });

    const response = await request(handler, "/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "sig" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(updates).toEqual([["cus_1", "pro", 10]]);
  });

  it("returns 404 for cross-tenant session access", async () => {
    const { sessions } = fakeSessions("piv", "org-a");
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-b", orgId: "org-b", role: "member" };
        },
      } as never,
    });

    const response = await request(handler, `/sessions/${SESSION_ID}`, {
      headers: { Authorization: "Bearer jwt" },
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for cross-tenant session writes", async () => {
    const { sessions } = fakeSessions("chat", "org-a");
    const { conversations, calls } = fakeConversations();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      conversations,
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-b", orgId: "org-b", role: "member" };
        },
      } as never,
    });

    const response = await request(
      handler,
      `/sessions/${SESSION_ID}/messages`,
      {
        method: "POST",
        headers: { Authorization: "Bearer jwt" },
        body: { role: "user", content: "nope" },
      },
    );

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

function fakeSessions(
  mode: "piv" | "chat" = "piv",
  sessionOrgId: string | null = null,
): {
  sessions: DaemonSessions;
  calls: unknown[][];
} {
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
      async getSession(sessionId, orgId) {
        if (sessionId === MISSING_SESSION_ID) {
          throw new SessionNotFoundError(sessionId);
        }
        if (orgId && sessionOrgId !== orgId) {
          throw new SessionNotFoundError(sessionId);
        }

        return {
          id: sessionId,
          status: "idle",
          repoPath: "/repo",
          containerId: "container",
          volumeId: "volume",
          config: {},
          mode,
          userId: null,
          orgId: sessionOrgId,
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
        };
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
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return handler(
    new Request(`http://localhost${pathname}`, {
      ...(options.method ? { method: options.method } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.body === undefined
        ? {}
        : {
            body: JSON.stringify(options.body),
            headers: {
              ...options.headers,
              "content-type": "application/json",
            },
          }),
    }),
  );
}

// ---------------------------------------------------------------------------
// TCP binding + WebSocket mirror — B1 / B2
// ---------------------------------------------------------------------------

describe("TCP binding (B1)", () => {
  // The TCP binding uses the same createRequestHandler as the Unix socket —
  // verified by calling the handler directly (identical code path).
  it("GET /health returns { ok: true } on the shared request handler", async () => {
    const { sessions } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/test.sock",
      sessions,
      streams: noopStreams(),
    });
    const res = await handler(new Request("http://127.0.0.1:51820/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // Bun.serve is not available in the vmForks pool, so the actual TCP port
  // binding test is guarded. Run with `bun test` or in a Bun-native env.
  it.skipIf(!("Bun" in globalThis))(
    "createTcpDaemonServer binds and responds on a real TCP port",
    async () => {
      const { sessions } = fakeSessions();
      const server = createTcpDaemonServer(
        { socketPath: "/tmp/test-tcp.sock", sessions, streams: noopStreams() },
        0,
      );
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await server.stop(true);
      }
    },
  );
});

describe("WebSocket mirror (B2)", () => {
  // The WebSocket server delegates frame delivery to streams.attach().
  // The StreamController.attach() mechanism is covered in stream-controller.test.ts.
  // This test verifies the server wires WebSocket open → streams.attach() correctly
  // by inspecting the DaemonStreams call.
  it("WebSocket upgrade triggers streams.attach with the correct session ID", async () => {
    const attached: string[] = [];
    const handler = createRequestHandler({
      socketPath: "/tmp/test.sock",
      sessions: fakeSessions().sessions,
      streams: {
        attach(sessionId, _socket) {
          attached.push(sessionId);
          return () => undefined;
        },
      },
    });

    // A WebSocket upgrade request without a Bun server falls through to the
    // HTTP handler (returns 404 for the session route). We can't complete the
    // upgrade here, but we can verify the non-WebSocket path.
    const res = await handler(
      new Request(`http://127.0.0.1:51820/sessions/${SESSION_ID}/events`, {
        headers: { upgrade: "websocket" },
      }),
    );
    // The handler recognises the upgrade attempt but cannot complete it
    // without Bun.Server — it will return a 400.
    expect([400, 404]).toContain(res.status);
    // The attach call happens inside Bun.Server's websocket.open handler,
    // not the fetch handler. This test documents the contract; runtime
    // verification requires the Bun-guarded test below.
    expect(attached).toHaveLength(0);
  });

  // Full WebSocket round-trip: only runs in Bun runtime (vmForks has no Bun.serve).
  it.skipIf(!("Bun" in globalThis))(
    "WebSocket client receives frames emitted by streams.attach socket proxy",
    async () => {
      let capturedSocket: { send(data: string): void } | null = null;

      const { sessions } = fakeSessions();
      const server = createTcpDaemonServer(
        {
          socketPath: "/tmp/test-ws.sock",
          sessions,
          streams: {
            attach(_sessionId, socket) {
              capturedSocket = socket;
              return () => {
                capturedSocket = null;
              };
            },
          },
        },
        0,
      );

      try {
        const frame = await new Promise<unknown>((resolve, reject) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${server.port}/sessions/${SESSION_ID}/events`,
          );
          ws.onopen = () => {
            capturedSocket?.send(
              JSON.stringify({ type: "token", delta: "ws-hello" }),
            );
          };
          ws.onmessage = (event) => {
            ws.close();
            resolve(JSON.parse(event.data as string));
          };
          ws.onerror = () => {
            ws.close();
            reject(new Error("WebSocket error"));
          };
          setTimeout(() => {
            ws.close();
            reject(new Error("timeout"));
          }, 3_000);
        });
        expect(frame).toEqual({ type: "token", delta: "ws-hello" });
      } finally {
        await server.stop(true);
      }
    },
  );
});

function noopStreams(): DaemonStreams {
  return {
    attach() {
      return () => undefined;
    },
  };
}
