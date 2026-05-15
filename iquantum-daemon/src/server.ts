import { InvalidTransitionError } from "@iquantum/piv-engine";
import { ZodError, z } from "zod";
import { logger } from "./logger";
import {
  MissingTestCommandError,
  SessionNotFoundError,
  SessionNotLiveError,
} from "./session-controller";
import type { StreamSocket } from "./stream-controller";

export interface DaemonServerOptions {
  socketPath: string;
  sessions: DaemonSessions;
  streams: DaemonStreams;
  healthCheck?: () => Promise<{ db: boolean; docker: boolean }>;
}

export interface DaemonSessions {
  createSession(repoPath: string): Promise<unknown>;
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
  handleMessage(sessionId: string, rawMessage: string): Promise<void>;
}

interface WebSocketData {
  detach: (() => void) | undefined;
  sessionId: string;
}

const createSessionSchema = z.object({ repoPath: z.string().min(1) });
const taskSchema = z.object({ prompt: z.string().min(1) });
const rejectSchema = z.object({ feedback: z.string().min(1) });

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function createDaemonServer(
  options: DaemonServerOptions,
): Bun.Server<WebSocketData> {
  return Bun.serve<WebSocketData>({
    unix: options.socketPath,
    fetch: createRequestHandler(options),
    websocket: {
      open(socket) {
        try {
          socket.data.detach = options.streams.attach(
            socket.data.sessionId,
            socket,
          );
        } catch (error) {
          socket.send(JSON.stringify(toErrorFrame(error)));
          socket.close(1008, "stream unavailable");
        }
      },
      async message(socket, message) {
        try {
          await options.streams.handleMessage(
            socket.data.sessionId,
            typeof message === "string" ? message : message.toString(),
          );
        } catch (error) {
          socket.send(JSON.stringify(toErrorFrame(error)));
        }
      },
      close(socket) {
        socket.data.detach?.();
      },
    },
  });
}

export function createRequestHandler(options: DaemonServerOptions) {
  return async (
    request: Request,
    server: Pick<Bun.Server<WebSocketData>, "upgrade">,
  ): Promise<Response | undefined> => {
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
        const session = await options.sessions.createSession(body.repoPath);
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
        const upgraded = server.upgrade(request, {
          data: { detach: undefined, sessionId },
        });
        return upgraded
          ? undefined
          : Response.json(
              { error: "websocket_upgrade_failed" },
              { status: 500 },
            );
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
        await options.sessions.approve(sessionId, parts[3]);
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
        const body = rejectSchema.parse(await request.json());
        const plan = await options.sessions.reject(
          sessionId,
          body.feedback,
          parts[3],
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
        await options.sessions.restore(sessionId, parts[3] ?? "");
        return Response.json({ ok: true });
      }

      return notFound();
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return Response.json(
      { error: "invalid_request", issues: error.issues },
      { status: 400 },
    );
  }

  if (error instanceof SessionNotFoundError) {
    return Response.json({ error: "session_not_found" }, { status: 404 });
  }

  if (
    error instanceof SessionNotLiveError ||
    error instanceof InvalidTransitionError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }

  if (error instanceof MissingTestCommandError) {
    return Response.json({ error: error.message }, { status: 422 });
  }

  logger.error({
    msg: "unhandled request error",
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
