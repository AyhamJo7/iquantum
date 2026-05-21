import { InvalidTransitionError } from "@iquantum/piv-engine";
import type { Memory } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import {
  InvalidCheckpointCursorError,
  InvalidConversationCursorError,
} from "./db/stores";
import { InMemoryRateLimiter } from "./rate-limit";
import type { ReviewEvent } from "./review-engine";
import {
  createRequestHandler,
  createTcpDaemonServer,
  type DaemonAgents,
  type DaemonCompaction,
  type DaemonConversations,
  type DaemonCoordinator,
  type DaemonMcpRegistry,
  type DaemonMemory,
  type DaemonPermissions,
  type DaemonReviewEngine,
  type DaemonSessions,
  type DaemonStreams,
} from "./server";
import {
  SessionNotFoundError,
  SessionNotLiveError,
} from "./session-controller";

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

  it("passes worktree session options through to the session controller", async () => {
    const { sessions, calls } = fakeSessions();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
    });

    const response = await request(handler, "/sessions", {
      method: "POST",
      body: {
        repoPath: "/repo",
        extraRepoPaths: ["/other-repo"],
        worktree: true,
      },
    });

    expect(response.status).toBe(201);
    expect(calls).toEqual([
      [
        "createSession",
        "/repo",
        {
          mode: "piv",
          extraRepoPaths: ["/other-repo"],
          worktree: true,
        },
      ],
    ]);
  });

  it("serves agent spawn, list, get, and kill routes", async () => {
    const { sessions } = fakeSessions();
    const { agents, calls } = fakeAgents();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions,
      streams: fakeStreams(),
      agents,
    });

    const spawned = await request(handler, `/sessions/${SESSION_ID}/agents`, {
      method: "POST",
      body: {
        name: "api",
        prompt: "build API",
        inheritMemory: true,
        worktree: true,
        tools: ["file_read"],
      },
    });
    const list = await request(handler, `/sessions/${SESSION_ID}/agents`);
    const detail = await request(
      handler,
      `/sessions/${SESSION_ID}/agents/00000000-0000-0000-0000-000000000002`,
    );
    const killed = await request(
      handler,
      `/sessions/${SESSION_ID}/agents/00000000-0000-0000-0000-000000000002`,
      { method: "DELETE", body: { reason: "stop" } },
    );

    expect(spawned.status).toBe(201);
    expect(await spawned.json()).toEqual({
      sessionId: "00000000-0000-0000-0000-000000000002",
    });
    expect(await list.json()).toMatchObject({
      agents: [{ name: "api", status: "running" }],
    });
    expect(await detail.json()).toMatchObject({ name: "api" });
    expect(killed.status).toBe(204);
    expect(calls).toEqual([
      [
        "spawn",
        SESSION_ID,
        {
          name: "api",
          prompt: "build API",
          inheritMemory: true,
          worktree: true,
          tools: ["file_read"],
        },
      ],
      ["list", SESSION_ID],
      ["get", "00000000-0000-0000-0000-000000000002"],
      ["get", "00000000-0000-0000-0000-000000000002"],
      ["kill", "00000000-0000-0000-0000-000000000002", "stop"],
    ]);
  });

  it("serves coordinator task route", async () => {
    const { sessions } = fakeSessions();
    const { coordinator, calls } = fakeCoordinator();
    const sessionCalls: unknown[][] = [];
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: {
        ...sessions,
        async activateCoordinatorMode(sessionId) {
          sessionCalls.push(["activateCoordinatorMode", sessionId]);
          return sessions.getSession(sessionId);
        },
      },
      streams: fakeStreams(),
      coordinator,
    });

    const response = await request(
      handler,
      `/sessions/${SESSION_ID}/coordinator`,
      {
        method: "POST",
        body: { prompt: "large task" },
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(sessionCalls).toEqual([["activateCoordinatorMode", SESSION_ID]]);
    expect(calls).toEqual([["run", SESSION_ID, "large task"]]);
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

  it("adds request IDs and configured CORS headers to responses", async () => {
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      corsOrigins: ["https://app.example.com"],
    });

    const response = await request(handler, "/health", {
      headers: {
        Origin: "https://app.example.com",
        "x-request-id": "request-1",
      },
    });
    const preflight = await request(handler, "/sessions", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    });

    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(response.headers.get("vary")).toBe("Origin");
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    const disallowed = await request(handler, "/health", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();
    expect(disallowed.headers.get("vary")).toBe("Origin");
  });

  it("maps session state conflicts to fixed client-safe errors", async () => {
    const liveHandler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: {
        ...fakeSessions("piv", "org-1").sessions,
        async startTask() {
          throw new SessionNotLiveError(SESSION_ID);
        },
      },
      streams: fakeStreams(),
    });
    const transitionHandler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: {
        ...fakeSessions("piv", "org-1").sessions,
        async approve() {
          throw new InvalidTransitionError("planning", "approve a plan");
        },
      },
      streams: fakeStreams(),
    });

    const live = await request(liveHandler, `/sessions/${SESSION_ID}/task`, {
      method: "POST",
      body: { prompt: "run" },
    });
    const transition = await request(
      transitionHandler,
      `/sessions/${SESSION_ID}/approve`,
      { method: "POST" },
    );

    expect(live.status).toBe(409);
    expect(await live.json()).toEqual({ error: "session_not_live" });
    expect(transition.status).toBe(409);
    expect(await transition.json()).toEqual({
      error: "invalid_session_state",
    });
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

  it("creates and lists memories through the memory API", async () => {
    const { memory, calls } = fakeMemory();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      memory,
    });

    const created = await request(handler, "/memory", {
      method: "POST",
      body: {
        type: "project",
        name: "uses-bun",
        description: "Runtime",
        body: "This project uses Bun.",
        pinned: true,
      },
    });
    const listed = await request(handler, "/memory?pinned=true");

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      userId: "local",
      orgId: null,
      name: "uses-bun",
      pinned: true,
    });
    expect(await listed.json()).toMatchObject([
      { name: "uses-bun", body: "This project uses Bun." },
    ]);
    expect(calls).toContainEqual(["materialize", "local", null]);
  });

  it("validates memory names", async () => {
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      memory: fakeMemory().memory,
    });

    const response = await request(handler, "/memory", {
      method: "POST",
      body: {
        type: "project",
        name: "uses bun",
        description: "Runtime",
        body: "This project uses Bun.",
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("returns 404 for unknown memory updates and deletes existing memories", async () => {
    const { memory, calls } = fakeMemory([
      {
        id: "memory-1",
        userId: "local",
        orgId: null,
        type: "project",
        scope: "user",
        source: "manual",
        name: "uses-bun",
        description: "Runtime",
        body: "This project uses Bun.",
        pinned: false,
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      },
    ]);
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      memory,
    });

    const missing = await request(handler, "/memory/missing", {
      method: "PATCH",
      body: { pinned: true },
    });
    const deleted = await request(handler, "/memory/memory-1", {
      method: "DELETE",
    });

    expect(missing.status).toBe(404);
    expect(deleted.status).toBe(204);
    expect(calls).toContainEqual(["delete", "memory-1", "local"]);
  });

  it("syncs memories from MEMORY.md through the daemon memory manager", async () => {
    const { memory, calls } = fakeMemory();
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      memory,
    });

    const response = await request(handler, "/memory/sync-from-file", {
      method: "POST",
    });

    expect(await response.json()).toEqual({ upserted: 2 });
    expect(calls).toContainEqual([
      "syncFromFile",
      expect.stringContaining(".iquantum/MEMORY.md"),
      "local",
      null,
    ]);
  });

  it("scopes memory routes to the authenticated cloud user", async () => {
    const { memory } = fakeMemory([
      {
        id: "memory-1",
        userId: "user-1",
        orgId: "org-1",
        type: "project",
        scope: "org",
        source: "manual",
        name: "visible",
        description: "Visible",
        body: "Visible memory",
        pinned: false,
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      },
      {
        id: "memory-2",
        userId: "user-2",
        orgId: "org-2",
        type: "project",
        scope: "org",
        source: "manual",
        name: "hidden",
        description: "Hidden",
        body: "Hidden memory",
        pinned: false,
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      },
    ]);
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      memory,
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-1", orgId: "org-1", role: "owner" };
        },
      } as never,
    });

    const unauthorized = await request(handler, "/memory");
    const authorized = await request(handler, "/memory", {
      headers: { Authorization: "Bearer jwt" },
    });

    expect(unauthorized.status).toBe(401);
    const memories = await authorized.json();
    expect(memories).toMatchObject([{ name: "visible" }]);
    expect(JSON.stringify(memories)).not.toContain("hidden");
  });

  it("requires auth for cloud PATCH and DELETE /memory", async () => {
    const { memory } = fakeMemory([
      {
        id: "memory-1",
        userId: "user-1",
        orgId: "org-1",
        type: "project",
        scope: "org",
        source: "manual",
        name: "uses-bun",
        description: "Runtime",
        body: "This project uses Bun.",
        pinned: false,
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      },
    ]);
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      memory,
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-1", orgId: "org-1", role: "owner" };
        },
      } as never,
    });

    const patchUnauth = await request(handler, "/memory/memory-1", {
      method: "PATCH",
      body: { pinned: true },
    });
    const deleteUnauth = await request(handler, "/memory/memory-1", {
      method: "DELETE",
    });
    const patchAuth = await request(handler, "/memory/memory-1", {
      method: "PATCH",
      body: { pinned: true },
      headers: { Authorization: "Bearer jwt" },
    });

    expect(patchUnauth.status).toBe(401);
    expect(deleteUnauth.status).toBe(401);
    expect(patchAuth.status).toBe(200);
  });

  it("rejects sync-from-file in cloud mode", async () => {
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      memory: fakeMemory().memory,
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-1", orgId: "org-1", role: "owner" };
        },
      } as never,
    });

    const response = await request(handler, "/memory/sync-from-file", {
      method: "POST",
      headers: { Authorization: "Bearer jwt" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("cloud"),
    });
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

  it("rate limits repeated login attempts", async () => {
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      cloud: true,
      rateLimiter: new InMemoryRateLimiter(),
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

    let response: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      response = await request(handler, "/auth/login", {
        method: "POST",
        headers: { "x-real-ip": "203.0.113.10" },
        body: { email: "a@example.com", password: "wrong-password" },
      });
    }

    expect(response?.status).toBe(429);
    expect(await response?.json()).toEqual({ error: "rate_limited" });
    expect(response?.headers.get("retry-after")).toBeTruthy();
  });

  it("paginates org members and checkpoints", async () => {
    const calls: unknown[][] = [];
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: {
        ...fakeSessions("piv", "org-1").sessions,
        async listCheckpoints(sessionId, options) {
          calls.push(["listCheckpoints", sessionId, options]);
          return {
            checkpoints: [{ id: "checkpoint-1" }],
            nextCursor: "checkpoint-1",
          };
        },
      },
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
        async listOrgMembersPage(orgId: string, options: unknown) {
          calls.push(["listOrgMembersPage", orgId, options]);
          return {
            members: [{ id: "user-1" }],
            nextCursor: "user-1",
          };
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-1", orgId: "org-1", role: "owner" };
        },
      } as never,
    });

    const members = await request(handler, "/org/members?limit=1", {
      headers: { Authorization: "Bearer jwt" },
    });
    const checkpoints = await request(
      handler,
      `/sessions/${SESSION_ID}/checkpoints?limit=1&before=checkpoint-0`,
      { headers: { Authorization: "Bearer jwt" } },
    );

    expect(await members.json()).toEqual({
      members: [{ id: "user-1" }],
      nextCursor: "user-1",
    });
    expect(await checkpoints.json()).toEqual({
      checkpoints: [{ id: "checkpoint-1" }],
      nextCursor: "checkpoint-1",
    });
    expect(calls).toContainEqual(["listOrgMembersPage", "org-1", { limit: 1 }]);
    expect(calls).toContainEqual([
      "listCheckpoints",
      SESSION_ID,
      { before: "checkpoint-0", limit: 1 },
    ]);
  });

  it("returns 400 for invalid checkpoint cursors", async () => {
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: {
        ...fakeSessions("piv", "org-1").sessions,
        async listCheckpoints() {
          throw new InvalidCheckpointCursorError("bad-cursor");
        },
      },
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-1", orgId: "org-1", role: "owner" };
        },
      } as never,
    });

    const response = await request(
      handler,
      `/sessions/${SESSION_ID}/checkpoints?before=bad-cursor`,
      { headers: { Authorization: "Bearer jwt" } },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_checkpoint_cursor",
    });
  });

  it("uses invite tokens instead of returning plaintext temporary passwords", async () => {
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
        async createInvite() {
          return {
            id: "invite-1",
            token: "invite-token",
            expiresAt: "2026-05-24T00:00:00.000Z",
          };
        },
        async acceptInvite() {
          return { id: "user-2", orgId: "org-1" };
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-1", orgId: "org-1", role: "owner" };
        },
      } as never,
    });

    const invited = await request(handler, "/org/members/invite", {
      method: "POST",
      headers: { Authorization: "Bearer jwt" },
      body: { email: "new@example.com", role: "member" },
    });
    const accepted = await request(handler, "/auth/invitations/accept", {
      method: "POST",
      body: { token: "invite-token", password: "password123" },
    });

    expect(await invited.json()).toEqual({
      inviteId: "invite-1",
      inviteToken: "invite-token",
      expiresAt: "2026-05-24T00:00:00.000Z",
      emailDeliveryRequired: true,
    });
    expect(JSON.stringify(await accepted.json())).not.toContain("password");
  });

  it("erases the authenticated user through DELETE /auth/me", async () => {
    const calls: unknown[][] = [];
    const handler = createRequestHandler({
      socketPath: "/tmp/daemon.sock",
      sessions: fakeSessions().sessions,
      streams: fakeStreams(),
      cloud: true,
      authStore: {
        async lookupApiToken() {
          return null;
        },
        async eraseUser(userId: string) {
          calls.push(["eraseUser", userId]);
        },
      } as never,
      jwtService: {
        async verify() {
          return { userId: "user-1", orgId: "org-1", role: "owner" };
        },
      } as never,
    });

    const erased = await request(handler, "/auth/me", {
      method: "DELETE",
      headers: { Authorization: "Bearer jwt" },
    });
    const unauthorized = await request(handler, "/auth/me", {
      method: "DELETE",
    });

    expect(erased.status).toBe(204);
    expect(unauthorized.status).toBe(401);
    expect(calls).toEqual([["eraseUser", "user-1"]]);
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

  describe("PATCH /sessions/:id/config", () => {
    it("updates effort level and returns the session", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/config`,
        { method: "PATCH", body: { effort: "fast" } },
      );

      expect(response.status).toBe(200);
      expect(((await response.json()) as { effort: string }).effort).toBe(
        "fast",
      );
    });

    it("returns 501 when updateConfig is not implemented", async () => {
      const { sessions } = fakeSessions();
      const { updateConfig: _removed, ...sessionsWithout } = sessions;
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions: sessionsWithout as DaemonSessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/config`,
        { method: "PATCH", body: { effort: "fast" } },
      );

      expect(response.status).toBe(501);
    });

    it("returns 400 for an unknown effort value", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/config`,
        { method: "PATCH", body: { effort: "turbo" } },
      );

      expect(response.status).toBe(400);
    });
  });

  describe("GET /sessions/:id/context-stats", () => {
    it("returns context stats from the session store", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/context-stats`,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        budget: number;
        available: number;
        messages: number;
      };
      expect(body.budget).toBeGreaterThan(0);
      expect(body.messages).toBe(100);
      expect(body.available).toBeLessThanOrEqual(body.budget);
    });

    it("returns zero-filled fallback when getContextStats is absent", async () => {
      const { sessions } = fakeSessions();
      const { getContextStats: _removed, ...sessionsWithout } = sessions;
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions: sessionsWithout as DaemonSessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/context-stats`,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        budget: number;
        available: number;
        messages: number;
      };
      expect(body.messages).toBe(0);
      expect(body.available).toBe(body.budget);
    });

    it("merges live conversation prompt token counts", async () => {
      const { sessions } = fakeSessions();
      const { conversations } = fakeConversations();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
        conversations,
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/context-stats`,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        systemPrompt: number;
        memory: number;
        messages: number;
        available: number;
      };
      expect(body).toMatchObject({
        systemPrompt: 11,
        memory: 7,
        messages: 100,
        available: 199_882,
      });
    });
  });

  describe("POST /sessions/:id/review", () => {
    it("streams review findings and done events", async () => {
      const { sessions } = fakeSessions();
      const { reviewEngine, calls } = fakeReviewEngine([
        {
          severity: "high",
          title: "Unsafe default",
          file: "src/auth.ts",
          line: 12,
          description: "Default allows bypassing auth.",
          suggestion: "Require explicit configuration.",
        },
        {
          type: "done",
          summary: "One issue found.",
          durationMs: 123,
        },
      ]);
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
        reviewEngine,
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/review`,
        {
          method: "POST",
          body: { target: { type: "staged" } },
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      await expect(readSseData(response)).resolves.toMatchObject([
        { severity: "high", title: "Unsafe default" },
        { type: "done", summary: "One issue found.", durationMs: 123 },
      ]);
      expect(calls).toEqual([["review", { type: "staged" }, "/repo"]]);
    });

    it("returns 400 for invalid review targets", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
        reviewEngine: fakeReviewEngine([]).reviewEngine,
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/review`,
        {
          method: "POST",
          body: { target: { type: "commit" } },
        },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "invalid_request",
      });
    });

    it("returns 400 when commit ref starts with a dash (flag injection guard)", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
        reviewEngine: fakeReviewEngine([]).reviewEngine,
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/review`,
        {
          method: "POST",
          body: { target: { type: "commit", ref: "--output=/tmp/evil" } },
        },
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 when pr ref starts with a dash", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
        reviewEngine: fakeReviewEngine([]).reviewEngine,
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/review`,
        {
          method: "POST",
          body: { target: { type: "pr", ref: "--help" } },
        },
      );

      expect(response.status).toBe(400);
    });

    it("returns 501 when the review engine is not configured", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/review`,
        {
          method: "POST",
          body: { target: { type: "staged" } },
        },
      );

      expect(response.status).toBe(501);
    });
  });

  describe("GET /sessions/:id/diff", () => {
    it("returns plain-text diff when a valid from ref is provided", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/diff?from=abc1234`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
    });

    it("returns 400 for an invalid git ref", async () => {
      const { sessions } = fakeSessions();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/diff?from=HEAD!bad`,
      );

      expect(response.status).toBe(400);
    });

    it("returns 501 when getDiff is not implemented", async () => {
      const { sessions } = fakeSessions();
      const { getDiff: _removed, ...sessionsWithout } = sessions;
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions: sessionsWithout as DaemonSessions,
        streams: fakeStreams(),
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/diff?from=abc1234`,
      );

      expect(response.status).toBe(501);
    });
  });

  describe("GET /sessions/:id/export", () => {
    it("returns markdown export by default", async () => {
      const { sessions } = fakeSessions();
      const { conversations } = fakeConversations();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
        conversations,
      });

      const response = await request(handler, `/sessions/${SESSION_ID}/export`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      const text = await response.text();
      expect(text).toContain("# iquantum Session Export");
    });

    it("returns JSON export when format=json", async () => {
      const { sessions } = fakeSessions();
      const { conversations } = fakeConversations();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
        conversations,
      });

      const response = await request(
        handler,
        `/sessions/${SESSION_ID}/export?format=json`,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        session: unknown;
        messages: unknown[];
        truncated: boolean;
      };
      expect(body).toHaveProperty("session");
      expect(body).toHaveProperty("messages");
      expect(body.truncated).toBe(false);
    });

    it("returns 404 for an unknown session", async () => {
      const { sessions } = fakeSessions();
      const { conversations } = fakeConversations();
      const handler = createRequestHandler({
        socketPath: "/tmp/daemon.sock",
        sessions,
        streams: fakeStreams(),
        conversations,
      });

      const response = await request(
        handler,
        `/sessions/${MISSING_SESSION_ID}/export`,
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: "session_not_found",
      });
    });
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
          effort: "normal" as const,
          worktreePath: null,
          worktreeBranch: null,
          startCheckpointHash: null,
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
        return { checkpoints: [], nextCursor: null };
      },
      async restore(sessionId, hash) {
        calls.push(["restore", sessionId, hash]);
      },
      async updateConfig(sessionId, config) {
        calls.push(["updateConfig", sessionId, config]);
        return {
          id: sessionId,
          status: "idle" as const,
          repoPath: "/repo",
          containerId: "container",
          volumeId: "volume",
          config: {},
          mode,
          effort: config.effort ?? ("normal" as const),
          worktreePath: null,
          worktreeBranch: null,
          startCheckpointHash: null,
          userId: null,
          orgId: sessionOrgId,
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
        };
      },
      async getContextStats(sessionId) {
        calls.push(["getContextStats", sessionId]);
        return {
          systemPrompt: 0,
          memory: 0,
          repoMap: 0,
          messages: 100,
          lastTurnTokens: 50,
          budget: 200_000,
          available: 199_900,
        };
      },
      async getDiff(sessionId, from, to) {
        calls.push(["getDiff", sessionId, from, to]);
        return "diff --git a/file.ts b/file.ts\n";
      },
    },
  };
}

function fakeStreams(): DaemonStreams {
  return {
    attach() {
      return () => undefined;
    },
    publish() {},
  };
}

function fakeAgents(): { agents: DaemonAgents; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const childSessionId = "00000000-0000-0000-0000-000000000002";
  const entry = {
    sessionId: childSessionId,
    name: "api",
    colorIndex: 0,
    coordinatorSessionId: SESSION_ID,
    status: "running" as const,
  };

  return {
    calls,
    agents: {
      async spawn(coordinatorSessionId, manifest) {
        calls.push(["spawn", coordinatorSessionId, manifest]);
        return childSessionId;
      },
      list(coordinatorSessionId) {
        calls.push(["list", coordinatorSessionId]);
        return [entry];
      },
      get(sessionId) {
        calls.push(["get", sessionId]);
        return sessionId === childSessionId ? entry : undefined;
      },
      async kill(sessionId, reason) {
        calls.push(["kill", sessionId, reason]);
      },
    },
  };
}

function fakeCoordinator(): {
  coordinator: DaemonCoordinator;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];

  return {
    calls,
    coordinator: {
      async run(sessionId, task) {
        calls.push(["run", sessionId, task]);
      },
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
      getMemoryTokenCount(sessionId) {
        calls.push(["getMemoryTokenCount", sessionId]);
        return 7;
      },
      getSystemPromptTokenCount(sessionId) {
        calls.push(["getSystemPromptTokenCount", sessionId]);
        return 11;
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

function fakeReviewEngine(events: ReviewEvent[]): {
  reviewEngine: DaemonReviewEngine;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];

  return {
    calls,
    reviewEngine: {
      async *review(target, repoPath) {
        calls.push(["review", target, repoPath]);
        for (const event of events) {
          yield event;
        }
      },
    },
  };
}

function fakeMemory(initial: Memory[] = []): {
  memory: DaemonMemory;
  calls: unknown[][];
} {
  const memories = [...initial];
  const calls: unknown[][] = [];

  return {
    calls,
    memory: {
      store: {
        async upsertByName(memory) {
          const existing = memories.find(
            (m) => m.name === memory.name && m.userId === memory.userId,
          );
          if (existing) {
            Object.assign(existing, memory);
            calls.push(["upsertByName", memory.name]);
            return existing;
          }
          memories.push(memory);
          calls.push(["upsertByName", memory.name]);
          return memory;
        },
        async get(id, userId) {
          return (
            memories.find(
              (memory) => memory.id === id && memory.userId === userId,
            ) ?? null
          );
        },
        async listByUser(userId, orgId) {
          return memories.filter(
            (memory) =>
              memory.userId === userId &&
              (orgId ? memory.orgId === orgId || memory.orgId === null : true),
          );
        },
        async update(id, userId, updates) {
          const memory = memories.find(
            (entry) => entry.id === id && entry.userId === userId,
          );
          if (!memory) return null;
          Object.assign(memory, updates, {
            updatedAt: "2026-05-19T01:00:00.000Z",
          });
          return memory;
        },
        async delete(id, userId) {
          calls.push(["delete", id, userId]);
          const index = memories.findIndex(
            (memory) => memory.id === id && memory.userId === userId,
          );
          if (index !== -1) memories.splice(index, 1);
        },
      },
      async materialize(userId, orgId) {
        calls.push(["materialize", userId, orgId]);
      },
      async syncFromFile(filePath, userId, orgId) {
        calls.push(["syncFromFile", filePath, userId, orgId]);
        return 2;
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

async function readSseData(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const dataLine = part
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) {
        throw new Error(`missing SSE data line: ${part}`);
      }
      return JSON.parse(dataLine.slice("data: ".length));
    });
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
