import { InvalidTransitionError } from "@iquantum/piv-engine";
import { ZodError, z } from "zod";
import { InvalidConversationCursorError } from "./db/stores";
import { logger } from "./logger";
import { PermissionRequestNotFoundError } from "./permission-gate";
import {
  SessionNotFoundError,
  SessionNotLiveError,
} from "./session-controller";
import type { StreamSocket } from "./stream-controller";

export interface DaemonServerOptions {
  socketPath: string;
  sessions: DaemonSessions;
  streams: DaemonStreams;
  conversations?: DaemonConversations;
  compaction?: DaemonCompaction;
  permissions?: DaemonPermissions;
  healthCheck?: () => Promise<{ db: boolean; docker: boolean }>;
}

export interface DaemonSessions {
  createSession(
    repoPath: string,
    options?: { requireApproval?: boolean; autoApprove?: boolean },
  ): Promise<unknown>;
  getSession(sessionId: string): Promise<unknown>;
  destroySession(sessionId: string): Promise<void>;
  startTask(sessionId: string, prompt: string): Promise<unknown>;
  currentPlan(sessionId: string): Promise<unknown | null>;
  approve(sessionId: string, planId?: string): Promise<void>;
  reject(
    sessionId: string,
    feedback: string,
    planId?: string,
  ): Promise<unknown>;
  listCheckpoints(sessionId: string): Promise<unknown>;
  restore(sessionId: string, hash: string): Promise<void>;
}

export interface DaemonStreams {
  attach(sessionId: string, socket: StreamSocket): () => void;
}

export interface DaemonConversations {
  addMessage(sessionId: string, content: string): Promise<void>;
  getMessages(
    sessionId: string,
    options?: { before?: string; limit?: number },
  ): Promise<unknown>;
  clear(sessionId: string): Promise<void>;
}

export interface DaemonCompaction {
  compact(sessionId: string): Promise<unknown | null>;
}

export interface DaemonPermissions {
  resolvePermission(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): void;
}

const createSessionSchema = z.object({
  repoPath: z.string().min(1),
  requireApproval: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
});
const taskSchema = z.object({ prompt: z.string().min(1) });
const rejectSchema = z.object({ feedback: z.string().min(1) });
const messageSchema = z.object({
  role: z.literal("user"),
  content: z.string().min(1),
});
const messageLimitSchema = z.coerce.number().int().min(1).max(200);
const permissionSchema = z.object({
  requestId: z.string().min(1),
  approved: z.boolean(),
});

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_ID_RE = SESSION_ID_RE;
const COMMIT_HASH_RE = /^[0-9a-f]{7,64}$/i;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function createDaemonServer(options: DaemonServerOptions) {
  return Bun.serve({
    unix: options.socketPath,
    fetch: createRequestHandler(options),
  });
}

export function createRequestHandler(options: DaemonServerOptions) {
  return async (request: Request): Promise<Response> => {
    const requestId =
      request.headers.get("x-request-id") ?? crypto.randomUUID();

    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      if (request.method === "GET" && url.pathname === "/health") {
        if (options.healthCheck) {
          const status = await options.healthCheck();
          const ok = status.db && status.docker;
          return Response.json({ ok, ...status }, { status: ok ? 200 : 503 });
        }

        return Response.json({ ok: true });
      }

      if (parts[0] !== "sessions") {
        return notFound();
      }

      if (request.method === "POST" && parts.length === 1) {
        const body = createSessionSchema.parse(await request.json());
        const session = await options.sessions.createSession(body.repoPath, {
          ...(body.requireApproval === undefined
            ? {}
            : { requireApproval: body.requireApproval }),
          ...(body.autoApprove === undefined
            ? {}
            : { autoApprove: body.autoApprove }),
        });
        return Response.json(session, { status: 201 });
      }

      const sessionId = parts[1];

      if (!sessionId || !isValidSessionId(sessionId)) {
        return notFound();
      }

      if (request.method === "GET" && parts.length === 2) {
        return Response.json(await options.sessions.getSession(sessionId));
      }

      if (request.method === "DELETE" && parts.length === 2) {
        await options.sessions.destroySession(sessionId);
        return new Response(null, { status: 204 });
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[2] === "stream"
      ) {
        const encoder = new TextEncoder();
        let detach: (() => void) | undefined;

        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const readable = new ReadableStream<Uint8Array>({
          start(controller) {
            const socket: StreamSocket = {
              send(data: string) {
                try {
                  controller.enqueue(encoder.encode(`data: ${data}\n\n`));
                } catch {
                  // client disconnected
                }
              },
              close() {
                clearInterval(heartbeat);
                try {
                  controller.close();
                } catch {
                  // already closed
                }
              },
            };

            try {
              detach = options.streams.attach(sessionId, socket);
            } catch (error) {
              socket.send(JSON.stringify(toErrorFrame(error)));
              controller.close();
              return;
            }

            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
              } catch {
                clearInterval(heartbeat);
              }
            }, 5000);
          },
          cancel() {
            clearInterval(heartbeat);
            detach?.();
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[2] === "permission"
      ) {
        const body = permissionSchema.parse(await request.json());
        const permissions = requirePermissions(options);
        await options.sessions.getSession(sessionId);
        permissions.resolvePermission(sessionId, body.requestId, body.approved);
        return Response.json({ ok: true });
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[2] === "messages"
      ) {
        const body = messageSchema.parse(await request.json());
        const conversations = requireConversations(options);
        await options.sessions.getSession(sessionId);
        void conversations
          .addMessage(sessionId, body.content)
          .catch((error: unknown) => {
            logger.error({
              msg: "conversation response failed",
              requestId,
              sessionId,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          });
        return Response.json({ accepted: true }, { status: 202 });
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[2] === "messages"
      ) {
        const conversations = requireConversations(options);
        await options.sessions.getSession(sessionId);
        const before = url.searchParams.get("before");
        return Response.json(
          await conversations.getMessages(sessionId, {
            ...(before ? { before } : {}),
            limit: readMessageLimit(url.searchParams.get("limit")),
          }),
        );
      }

      if (
        request.method === "DELETE" &&
        parts.length === 3 &&
        parts[2] === "messages"
      ) {
        const conversations = requireConversations(options);
        await options.sessions.getSession(sessionId);
        await conversations.clear(sessionId);
        return new Response(null, { status: 204 });
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[2] === "compact"
      ) {
        const compaction = requireCompaction(options);
        await options.sessions.getSession(sessionId);
        const summary = await compaction.compact(sessionId);
        return Response.json({ compacted: summary !== null, summary });
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        (parts[2] === "task" || parts[2] === "tasks")
      ) {
        const body = taskSchema.parse(await request.json());
        const plan = await options.sessions.startTask(sessionId, body.prompt);
        return Response.json(plan, { status: 202 });
      }

      if (
        request.method === "GET" &&
        ((parts.length === 3 && parts[2] === "plan") ||
          (parts.length === 4 &&
            parts[2] === "plans" &&
            parts[3] === "current"))
      ) {
        const plan = await options.sessions.currentPlan(sessionId);
        return plan ? Response.json(plan) : notFound();
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[2] === "approve"
      ) {
        await options.sessions.approve(sessionId);
        return Response.json({ ok: true });
      }

      if (
        request.method === "POST" &&
        parts.length === 5 &&
        parts[2] === "plans" &&
        parts[4] === "approve"
      ) {
        const planId = parts[3];

        if (!planId || !PLAN_ID_RE.test(planId)) {
          return notFound();
        }

        await options.sessions.approve(sessionId, planId);
        return Response.json({ ok: true });
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[2] === "reject"
      ) {
        const body = rejectSchema.parse(await request.json());
        const plan = await options.sessions.reject(sessionId, body.feedback);
        return Response.json(plan);
      }

      if (
        request.method === "POST" &&
        parts.length === 5 &&
        parts[2] === "plans" &&
        parts[4] === "reject"
      ) {
        const planId = parts[3];

        if (!planId || !PLAN_ID_RE.test(planId)) {
          return notFound();
        }

        const body = rejectSchema.parse(await request.json());
        const plan = await options.sessions.reject(
          sessionId,
          body.feedback,
          planId,
        );
        return Response.json(plan);
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[2] === "checkpoints"
      ) {
        return Response.json(await options.sessions.listCheckpoints(sessionId));
      }

      if (
        request.method === "POST" &&
        parts.length === 5 &&
        parts[2] === "checkpoints" &&
        parts[4] === "restore"
      ) {
        const hash = parts[3];

        if (!hash || !COMMIT_HASH_RE.test(hash)) {
          return notFound();
        }

        await options.sessions.restore(sessionId, hash);
        return Response.json({ ok: true });
      }

      return notFound();
    } catch (error) {
      return toErrorResponse(error, requestId);
    }
  };
}

function requireConversations(
  options: DaemonServerOptions,
): DaemonConversations {
  if (!options.conversations) {
    throw new Error("ConversationController is not configured");
  }

  return options.conversations;
}

function requireCompaction(options: DaemonServerOptions): DaemonCompaction {
  if (!options.compaction) {
    throw new Error("CompactionService is not configured");
  }

  return options.compaction;
}

function requirePermissions(options: DaemonServerOptions): DaemonPermissions {
  if (!options.permissions) {
    throw new Error("PermissionGate is not configured");
  }

  return options.permissions;
}

function readMessageLimit(value: string | null): number {
  if (value === null) {
    return 50;
  }

  return messageLimitSchema.parse(value);
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

function toErrorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "invalid_request", issues: error.issues },
      { status: 400 },
    );
  }

  if (error instanceof SessionNotFoundError) {
    return Response.json({ error: "session_not_found" }, { status: 404 });
  }

  if (error instanceof PermissionRequestNotFoundError) {
    return Response.json(
      { error: "permission_request_not_found" },
      { status: 404 },
    );
  }

  if (error instanceof InvalidConversationCursorError) {
    return Response.json(
      { error: "invalid_conversation_cursor" },
      { status: 400 },
    );
  }

  if (
    error instanceof SessionNotLiveError ||
    error instanceof InvalidTransitionError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }

  logger.error({
    msg: "unhandled request error",
    requestId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return Response.json({ error: "internal_error" }, { status: 500 });
}

function toErrorFrame(error: unknown): { type: "error"; message: string } {
  return {
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}
