import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { InvalidTransitionError } from "@iquantum/piv-engine";
import type { Session } from "@iquantum/types";
import { ZodError, z } from "zod";
import { type AuthContext, authMiddleware } from "./auth/auth-middleware";
import type { AuthStore } from "./auth/auth-store";
import type { JwtService } from "./auth/jwt-service";
import type { BillingTracker } from "./billing-tracker";
import { InvalidConversationCursorError } from "./db/stores";
import { logger } from "./logger";
import { PermissionRequestNotFoundError } from "./permission-gate";
import {
  SessionNotFoundError,
  SessionNotLiveError,
} from "./session-controller";
import type { StreamSocket } from "./stream-controller";
import type { StripeClient } from "./stripe-client";

export interface DaemonMcpRegistry {
  listAllTools(): Promise<
    Array<{
      serverName: string;
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>
  >;
}

export interface DaemonServerOptions {
  socketPath: string;
  sessions: DaemonSessions;
  streams: DaemonStreams;
  conversations?: DaemonConversations;
  compaction?: DaemonCompaction;
  permissions?: DaemonPermissions;
  mcpRegistry?: DaemonMcpRegistry;
  healthCheck?: () => Promise<{ db: boolean; docker: boolean }>;
  cloud?: boolean;
  authStore?: AuthStore;
  jwtService?: JwtService;
  stripeClient?: StripeClient;
  stripeWebhookSecret?: string;
  billingTracker?: BillingTracker;
}

export interface DaemonSessions {
  createSession(
    repoPath: string,
    options?: {
      requireApproval?: boolean;
      autoApprove?: boolean;
      mode?: "piv" | "chat";
    },
    context?: AuthContext,
  ): Promise<unknown>;
  getSession(sessionId: string, orgId?: string): Promise<Session>;
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
  addMessage(sessionId: string, content: string, orgId?: string): Promise<void>;
  getMessages(
    sessionId: string,
    options?: { before?: string; limit?: number },
    orgId?: string,
  ): Promise<unknown>;
  clear(sessionId: string, orgId?: string): Promise<void>;
  cancel(sessionId: string): void;
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
  repoPath: z.string().min(1).refine(isAbsolute, {
    message: "repoPath must be an absolute path",
  }),
  requireApproval: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
  mode: z.enum(["piv", "chat"]).default("piv"),
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
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  orgName: z.string().min(1).optional(),
});
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const apiTokenSchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});
const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["owner", "member"]).default("member"),
});

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_ID_RE = SESSION_ID_RE;
const COMMIT_HASH_RE = /^[0-9a-f]{7,64}$/i;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function createDaemonServer(options: DaemonServerOptions) {
  return Bun.serve(createServeOptions(options, { unix: options.socketPath }));
}

export function createTcpDaemonServer(
  options: DaemonServerOptions,
  port: number,
) {
  return Bun.serve(
    createServeOptions(options, {
      hostname: "127.0.0.1",
      port,
    }),
  );
}

export function createRequestHandler(options: DaemonServerOptions) {
  return async (request: Request): Promise<Response> => {
    const requestId =
      request.headers.get("x-request-id") ?? crypto.randomUUID();

    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      let context: AuthContext | null = null;
      if (options.cloud && !isAuthExempt(request.method, url.pathname)) {
        const authStore = requireAuthStore(options);
        const jwtService = requireJwtService(options);
        context = await authMiddleware(request, authStore, jwtService);
        if (!context) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
      }

      if (request.method === "GET" && url.pathname === "/health") {
        if (options.healthCheck) {
          const status = await options.healthCheck();
          const ok = status.db && status.docker;
          return Response.json({ ok, ...status }, { status: ok ? 200 : 503 });
        }

        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/auth/register") {
        const body = registerSchema.parse(await request.json());
        const authStore = requireAuthStore(options);
        try {
          const org = await authStore.createOrg(
            body.orgName ?? body.email.split("@")[1] ?? body.email,
          );
          const user = await authStore.createUser(
            org.id,
            body.email,
            body.password,
            "owner",
          );
          return Response.json(
            { userId: user.id, orgId: org.id },
            { status: 201 },
          );
        } catch (error) {
          const isDuplicate =
            (error as { code?: string }).code === "23505" ||
            String(error).includes("UNIQUE");
          if (isDuplicate) {
            return Response.json({ error: "email_exists" }, { status: 409 });
          }
          throw error;
        }
      }

      if (request.method === "POST" && url.pathname === "/auth/login") {
        const body = loginSchema.parse(await request.json());
        const authStore = requireAuthStore(options);
        const jwtService = requireJwtService(options);
        const user = await authStore.verifyPassword(body.email, body.password);
        if (!user) {
          return Response.json(
            { error: "Invalid credentials" },
            { status: 401 },
          );
        }
        return Response.json({
          jwt: await jwtService.sign({
            userId: user.id,
            orgId: user.orgId,
            role: user.role,
          }),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
      }

      if (request.method === "POST" && url.pathname === "/webhooks/stripe") {
        const stripe = options.stripeClient;
        const secret = options.stripeWebhookSecret;
        const signature = request.headers.get("stripe-signature");
        if (!stripe || !secret || !signature) {
          return Response.json(
            { error: "stripe_not_configured" },
            { status: 400 },
          );
        }
        const event = stripe.constructWebhookEvent(
          await request.text(),
          signature,
          secret,
        );
        const authStore = requireAuthStore(options);
        if (event.type === "customer.subscription.deleted") {
          const subscription = event.data.object as {
            customer: string;
          };
          await authStore.updateOrgPlanByStripeCustomer(
            subscription.customer,
            "free",
            0,
          );
        }
        if (event.type === "customer.subscription.updated") {
          const subscription = event.data.object as {
            customer: string;
            metadata?: { plan?: string; sandboxQuotaHours?: string };
          };
          const plan =
            subscription.metadata?.plan === "enterprise" ||
            subscription.metadata?.plan === "pro"
              ? subscription.metadata.plan
              : "free";
          const parsedQuota = Number.parseInt(
            subscription.metadata?.sandboxQuotaHours ?? "10",
            10,
          );
          await authStore.updateOrgPlanByStripeCustomer(
            subscription.customer,
            plan,
            parsedQuota || 10,
          );
        }
        return Response.json({ received: true });
      }

      if (request.method === "GET" && url.pathname === "/auth/tokens") {
        const tokens = await requireAuthStore(options).listApiTokens(
          requireContext(context).userId,
        );
        return Response.json({ tokens });
      }

      if (request.method === "POST" && url.pathname === "/auth/tokens") {
        const body = apiTokenSchema.parse(await request.json());
        const authStore = requireAuthStore(options);
        const created = await authStore.createApiToken(
          requireContext(context).userId,
          body.name,
          body.scopes,
          body.expiresAt ? new Date(body.expiresAt) : undefined,
        );
        return Response.json({
          id: created.record.id,
          token: created.token,
          name: created.record.name,
          expiresAt: created.record.expiresAt,
        });
      }

      if (
        request.method === "DELETE" &&
        parts[0] === "auth" &&
        parts[1] === "tokens" &&
        parts[2]
      ) {
        await requireAuthStore(options).revokeApiToken(
          parts[2],
          requireContext(context).userId,
        );
        return new Response(null, { status: 204 });
      }

      if (request.method === "GET" && url.pathname === "/org/usage") {
        const authStore = requireAuthStore(options);
        const auth = requireContext(context);
        const now = new Date();
        const monthStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        );
        const [usage, org] = await Promise.all([
          authStore.getOrgUsage(auth.orgId, monthStart),
          authStore.getOrg(auth.orgId),
        ]);
        return Response.json({
          containerMinutes: usage.containerMinutes,
          quotaHours: org.sandboxQuotaHours,
          percentUsed:
            org.sandboxQuotaHours === 0
              ? 100
              : (usage.containerMinutes / (org.sandboxQuotaHours * 60)) * 100,
        });
      }

      if (request.method === "GET" && url.pathname === "/org/members") {
        const members = await requireAuthStore(options).listOrgMembers(
          requireContext(context).orgId,
        );
        return Response.json({ members });
      }

      if (request.method === "POST" && url.pathname === "/org/members/invite") {
        const authStore = requireAuthStore(options);
        const auth = requireContext(context);
        if (auth.role !== "owner") {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        const body = inviteSchema.parse(await request.json());
        const tempPassword = randomBytes(12).toString("base64url");
        const user = await authStore.createUser(
          auth.orgId,
          body.email,
          tempPassword,
          body.role,
        );
        return Response.json(
          { userId: user.id, tempPassword },
          { status: 201 },
        );
      }

      if (
        request.method === "POST" &&
        url.pathname === "/billing/portal-session" &&
        options.stripeClient
      ) {
        const auth = requireContext(context);
        const authStore = requireAuthStore(options);
        const org = await authStore.getOrg(auth.orgId);
        if (!org.stripeCustomerId) {
          return Response.json(
            { error: "no_stripe_customer" },
            { status: 400 },
          );
        }
        const { returnUrl } = z
          .object({ returnUrl: z.string().url() })
          .parse(await request.json());
        const url_ = await options.stripeClient.createPortalSession(
          org.stripeCustomerId,
          returnUrl,
        );
        return Response.json({ url: url_ });
      }

      if (
        request.method === "GET" &&
        parts.length === 2 &&
        parts[0] === "mcp" &&
        parts[1] === "tools"
      ) {
        const tools = options.mcpRegistry
          ? await options.mcpRegistry.listAllTools()
          : [];
        return Response.json(tools);
      }

      if (parts[0] !== "sessions") {
        return notFound();
      }

      if (request.method === "POST" && parts.length === 1) {
        const body = createSessionSchema.parse(await request.json());
        if (context && options.billingTracker) {
          await options.billingTracker.checkQuota(context.orgId);
        }
        const session = (await options.sessions.createSession(
          body.repoPath,
          {
            ...(body.requireApproval === undefined
              ? {}
              : { requireApproval: body.requireApproval }),
            ...(body.autoApprove === undefined
              ? {}
              : { autoApprove: body.autoApprove }),
            mode: body.mode,
          },
          context ?? undefined,
        )) as Session;
        if (context && options.billingTracker) {
          await options.billingTracker.onContainerStart(
            session.id,
            context.orgId,
          );
        }
        return Response.json(session, { status: 201 });
      }

      const sessionId = parts[1];

      if (!sessionId || !isValidSessionId(sessionId)) {
        return notFound();
      }

      if (options.cloud) {
        await options.sessions.getSession(sessionId, context?.orgId);
      }

      if (request.method === "GET" && parts.length === 2) {
        return Response.json(
          await options.sessions.getSession(sessionId, context?.orgId),
        );
      }

      if (request.method === "DELETE" && parts.length === 2) {
        await options.sessions.destroySession(sessionId);
        if (context && options.billingTracker) {
          await options.billingTracker.onContainerStop(sessionId);
        }
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
        const session = await options.sessions.getSession(
          sessionId,
          context?.orgId,
        );
        if (session.mode === "chat") {
          void conversations
            .addMessage(sessionId, body.content, context?.orgId)
            .catch((error: unknown) => {
              logger.error({
                msg: "conversation response failed",
                requestId,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
            });
        } else {
          void options.sessions
            .startTask(sessionId, body.content)
            .catch((error: unknown) => {
              logger.error({
                msg: "task start failed",
                requestId,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
            });
        }
        return Response.json({ accepted: true }, { status: 202 });
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[2] === "messages"
      ) {
        const conversations = requireConversations(options);
        await options.sessions.getSession(sessionId, context?.orgId);
        const before = url.searchParams.get("before");
        return Response.json(
          await conversations.getMessages(
            sessionId,
            {
              ...(before ? { before } : {}),
              limit: readMessageLimit(url.searchParams.get("limit")),
            },
            context?.orgId,
          ),
        );
      }

      if (
        request.method === "DELETE" &&
        parts.length === 3 &&
        parts[2] === "messages"
      ) {
        const conversations = requireConversations(options);
        await options.sessions.getSession(sessionId, context?.orgId);
        await conversations.clear(sessionId, context?.orgId);
        return new Response(null, { status: 204 });
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[2] === "cancel"
      ) {
        const conversations = requireConversations(options);
        await options.sessions.getSession(sessionId, context?.orgId);
        conversations.cancel(sessionId);
        return Response.json({ ok: true });
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[2] === "compact"
      ) {
        const compaction = requireCompaction(options);
        await options.sessions.getSession(sessionId, context?.orgId);
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
        await options.sessions.getSession(sessionId, context?.orgId);
        const plan = (await options.sessions.currentPlan(sessionId)) as
          | ({ content?: string } & Record<string, unknown>)
          | null;
        if (!plan) {
          return notFound();
        }
        if (parts.length === 3 && parts[2] === "plan") {
          const session = await options.sessions.getSession(
            sessionId,
            context?.orgId,
          );
          const content = await readFile(
            join(session.repoPath, "PLAN.md"),
            "utf8",
          ).catch(() => plan.content);
          return Response.json({ ...plan, content });
        }
        return Response.json(plan);
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

interface WebSocketData {
  sessionId?: string;
  detach?: () => void;
}

function createServeOptions(
  options: DaemonServerOptions,
  binding:
    | { unix: string }
    | {
        hostname: string;
        port: number;
      },
) {
  const handler = createRequestHandler(options);

  return {
    ...binding,
    async fetch(request: Request, server: Bun.Server<WebSocketData>) {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        parts[0] === "sessions" &&
        parts[1] &&
        isValidSessionId(parts[1]) &&
        parts[2] === "events"
      ) {
        let context: AuthContext | null = null;
        if (options.cloud) {
          context = await authMiddleware(
            request,
            requireAuthStore(options),
            requireJwtService(options),
          );
          if (!context) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          }
        }

        try {
          await options.sessions.getSession(parts[1], context?.orgId);
        } catch (error) {
          return toErrorResponse(error, crypto.randomUUID());
        }

        const upgraded = server.upgrade(request, {
          data: { sessionId: parts[1] },
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      return handler(request);
    },
    websocket: {
      data: {} as WebSocketData,
      message() {
        // server-to-client only
      },
      open(socket: Bun.ServerWebSocket<WebSocketData>) {
        const sessionId = socket.data.sessionId;
        if (!sessionId) {
          socket.close(1008, "missing session");
          return;
        }
        socket.data.detach = options.streams.attach(sessionId, {
          send(data) {
            socket.send(data);
          },
          close(code, reason) {
            socket.close(code, reason);
          },
        });
      },
      close(socket: Bun.ServerWebSocket<WebSocketData>) {
        socket.data.detach?.();
      },
    },
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

function requireAuthStore(options: DaemonServerOptions): AuthStore {
  if (!options.authStore) {
    throw new Error("AuthStore is not configured");
  }
  return options.authStore;
}

function requireJwtService(options: DaemonServerOptions): JwtService {
  if (!options.jwtService) {
    throw new Error("JwtService is not configured");
  }
  return options.jwtService;
}

function requireContext(context: AuthContext | null): AuthContext {
  if (!context) {
    throw new Error("Missing auth context");
  }
  return context;
}

function isAuthExempt(method: string, pathname: string): boolean {
  return (
    (method === "POST" &&
      (pathname === "/auth/register" ||
        pathname === "/auth/login" ||
        pathname === "/webhooks/stripe")) ||
    (method === "GET" && pathname === "/health")
  );
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
