import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { InvalidTransitionError } from "@iquantum/piv-engine";
import type {
  ContextStats,
  EffortLevel,
  Memory,
  Session,
} from "@iquantum/types";
import { CONTEXT_TOKEN_BUDGET } from "@iquantum/types";
import { formatSessionMarkdown } from "@iquantum/ui-core/export-markdown";
import { ZodError, z } from "zod";
import { type AuthContext, authMiddleware } from "./auth/auth-middleware";
import {
  type AuthStore,
  InvalidInviteTokenError,
  InvalidMemberCursorError,
} from "./auth/auth-store";
import type { JwtService } from "./auth/jwt-service";
import type { BillingTracker } from "./billing-tracker";
import {
  InvalidCheckpointCursorError,
  InvalidConversationCursorError,
} from "./db/stores";
import type { ErrorReporter } from "./error-reporter";
import { logger } from "./logger";
import { PermissionRequestNotFoundError } from "./permission-gate";
import type { RateLimiter, RateLimitOptions } from "./rate-limit";
import type { ReviewEvent, ReviewTarget } from "./review-engine";
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
  snapshots?: DaemonSnapshots;
  permissions?: DaemonPermissions;
  mcpRegistry?: DaemonMcpRegistry;
  hooks?: DaemonHooks;
  reviewEngine?: DaemonReviewEngine;
  memory?: DaemonMemory;
  memoryUserId?: string;
  healthCheck?: () => Promise<{
    db: boolean;
    docker: boolean;
    redis?: boolean;
  }>;
  cloud?: boolean;
  authStore?: AuthStore;
  jwtService?: JwtService;
  stripeClient?: StripeClient;
  stripeWebhookSecret?: string;
  billingTracker?: BillingTracker;
  rateLimiter?: RateLimiter;
  corsOrigins?: string[];
  errorReporter?: ErrorReporter;
}

export interface DaemonHooks {
  list(): Array<{ name: string; events: string[]; filePath: string }>;
}

export interface DaemonReviewEngine {
  review(target: ReviewTarget, repoPath: string): AsyncIterable<ReviewEvent>;
}

export interface DaemonMemory {
  store: {
    upsertByName(memory: Memory): Promise<Memory>;
    get(id: string, userId: string): Promise<Memory | null>;
    listByUser(userId: string, orgId?: string | null): Promise<Memory[]>;
    update(
      id: string,
      userId: string,
      updates: Partial<
        Pick<Memory, "type" | "name" | "description" | "body" | "pinned">
      >,
    ): Promise<Memory | null>;
    delete(id: string, userId: string): Promise<void>;
  };
  materialize(userId: string, orgId: string | null): Promise<void>;
  syncFromFile(
    filePath: string,
    userId: string,
    orgId: string | null,
  ): Promise<number>;
}

export interface DaemonSessions {
  createSession(
    repoPath: string,
    options?: {
      requireApproval?: boolean;
      autoApprove?: boolean;
      mode?: "piv" | "chat";
      effort?: import("@iquantum/types").EffortLevel;
      extraRepoPaths?: string[];
      worktree?: boolean;
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
  listCheckpoints(
    sessionId: string,
    options?: { before?: string; limit: number },
  ): Promise<unknown>;
  restore(sessionId: string, hash: string): Promise<void>;
  updateConfig?(
    sessionId: string,
    config: { effort?: import("@iquantum/types").EffortLevel },
  ): Promise<Session>;
  getContextStats?(sessionId: string, orgId?: string): Promise<ContextStats>;
  getDiff?(sessionId: string, from?: string, to?: string): Promise<string>;
}

export interface DaemonStreams {
  attach(sessionId: string, socket: StreamSocket): () => void;
}

export interface DaemonConversations {
  addMessage(
    sessionId: string,
    content: string,
    userId?: string,
    orgId?: string,
  ): Promise<void>;
  getMessages(
    sessionId: string,
    options?: { before?: string; limit?: number },
    orgId?: string,
  ): Promise<unknown>;
  clear(sessionId: string, orgId?: string): Promise<void>;
  cancel(sessionId: string): void;
  getMemoryTokenCount?(sessionId: string): number;
  getSystemPromptTokenCount?(sessionId: string): number;
}

export interface DaemonCompaction {
  compact(sessionId: string): Promise<{ summary: { content: string } } | null>;
}

export interface DaemonSnapshots {
  listTurns(sessionId: string): Promise<unknown>;
  restore(sessionId: string, turnIndex: number): Promise<Map<string, string>>;
  restoreToSandbox(sessionId: string, turnIndex: number): Promise<void>;
  diff(sessionId: string, fromTurn: number, toTurn: number): Promise<unknown>;
}

interface ExportMessage {
  role: string;
  content: unknown;
  createdAt: string;
}

export interface DaemonPermissions {
  resolvePermission(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): void;
}

const effortSchema = z.enum(["fast", "normal", "thorough"]);
const createSessionSchema = z.object({
  repoPath: z.string().min(1).refine(isAbsolute, {
    message: "repoPath must be an absolute path",
  }),
  extraRepoPaths: z
    .array(
      z.string().min(1).refine(isAbsolute, {
        message: "each extraRepoPath must be an absolute path",
      }),
    )
    .optional(),
  requireApproval: z.boolean().optional(),
  autoApprove: z.boolean().optional(),
  mode: z.enum(["piv", "chat"]).default("piv"),
  effort: effortSchema.optional(),
  worktree: z.boolean().optional().default(false),
});
const patchConfigSchema = z
  .object({
    effort: effortSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one config field is required",
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
const safeRef = z.string().min(1).regex(/^[^-]/, "ref must not start with -");
const reviewTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("staged") }),
  z.object({ type: z.literal("commit"), ref: safeRef }),
  z.object({ type: z.literal("path"), path: z.string().min(1) }),
  z.object({ type: z.literal("pr"), ref: safeRef }),
]);
const reviewSchema = z.object({ target: reviewTargetSchema });
const memoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);
const memoryNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/);
const memoryCreateSchema = z.object({
  type: memoryTypeSchema,
  name: memoryNameSchema,
  description: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
  pinned: z.boolean().optional().default(false),
});
const memoryUpdateSchema = memoryCreateSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one memory field is required",
  });
const memoryPinnedSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const memoryPageSchema = z.coerce.number().int().min(1).default(1);
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
const acceptInviteSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(8),
});
const pageLimitSchema = z.coerce.number().int().min(1).max(100);

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_ID_RE = SESSION_ID_RE;
const COMMIT_HASH_RE = /^[0-9a-f]{7,64}$/i;
// Allows hex SHAs, HEAD, HEAD~N, branch/tag names. Blocks shell metacharacters.
const GIT_REF_RE = /^[a-zA-Z0-9._/~^:-]{1,200}$/;
const EXPORT_MESSAGE_LIMIT = 500;

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
      hostname: options.cloud ? "0.0.0.0" : "127.0.0.1",
      port,
    }),
  );
}

export function createRequestHandler(options: DaemonServerOptions) {
  return async (request: Request): Promise<Response> => {
    const requestId =
      request.headers.get("x-request-id") ?? crypto.randomUUID();
    const corsHeaders = corsHeadersFor(request, options);

    if (request.method === "OPTIONS") {
      return withStandardHeaders(
        new Response(null, {
          status: corsHeaders ? 204 : 404,
          ...(corsHeaders ? { headers: corsHeaders } : {}),
        }),
        requestId,
        corsHeaders,
      );
    }

    const response = await handleRequest(options, request, requestId);
    return withStandardHeaders(response, requestId, corsHeaders);
  };
}

async function handleRequest(
  options: DaemonServerOptions,
  request: Request,
  requestId: string,
): Promise<Response> {
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
        const ok = status.db && status.docker && (status.redis ?? true);
        return Response.json({ ok, ...status }, { status: ok ? 200 : 503 });
      }

      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/hooks") {
      return Response.json(options.hooks?.list() ?? []);
    }

    if (request.method === "POST" && url.pathname === "/auth/register") {
      const body = registerSchema.parse(await request.json());
      const limited = await enforceAuthRateLimit(options, request, {
        endpoint: "register",
        email: body.email,
      });
      if (limited) return limited;
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
      const limited = await enforceAuthRateLimit(options, request, {
        endpoint: "login",
        email: body.email,
      });
      if (limited) return limited;
      const authStore = requireAuthStore(options);
      const jwtService = requireJwtService(options);
      const user = await authStore.verifyPassword(body.email, body.password);
      if (!user) {
        return Response.json({ error: "Invalid credentials" }, { status: 401 });
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

    if (
      request.method === "POST" &&
      url.pathname === "/auth/invitations/accept"
    ) {
      const rateLimitResponse = await enforceAuthRateLimit(options, request, {
        endpoint: "acceptInvite",
      });
      if (rateLimitResponse) return rateLimitResponse;
      const body = acceptInviteSchema.parse(await request.json());
      const user = await requireAuthStore(options).acceptInvite(
        body.token,
        body.password,
      );
      return Response.json(
        { userId: user.id, orgId: user.orgId },
        { status: 201 },
      );
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

    if (request.method === "DELETE" && url.pathname === "/auth/me") {
      await requireAuthStore(options).eraseUser(requireContext(context).userId);
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
      const page = await requireAuthStore(options).listOrgMembersPage(
        requireContext(context).orgId,
        readPageOptions(url.searchParams),
      );
      return Response.json(page);
    }

    if (request.method === "POST" && url.pathname === "/org/members/invite") {
      const authStore = requireAuthStore(options);
      const auth = requireContext(context);
      if (auth.role !== "owner") {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
      const body = inviteSchema.parse(await request.json());
      const invite = await authStore.createInvite(
        auth.orgId,
        body.email,
        body.role,
        auth.userId,
      );
      return Response.json(
        {
          inviteId: invite.id,
          inviteToken: invite.token,
          expiresAt: invite.expiresAt,
          emailDeliveryRequired: true,
        },
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
        return Response.json({ error: "no_stripe_customer" }, { status: 400 });
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

    if (parts[0] === "memory") {
      return await handleMemoryRequest(options, request, url, parts, context);
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
          ...(body.extraRepoPaths?.length
            ? { extraRepoPaths: body.extraRepoPaths }
            : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          ...(body.worktree ? { worktree: true } : {}),
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
      request.method === "GET" &&
      parts.length === 3 &&
      parts[2] === "snapshots"
    ) {
      const snapshots = requireSnapshots(options);
      await options.sessions.getSession(sessionId, context?.orgId);
      return Response.json({ turns: await snapshots.listTurns(sessionId) });
    }

    if (
      request.method === "GET" &&
      parts.length === 4 &&
      parts[2] === "snapshots" &&
      parts[3] === "diff"
    ) {
      const snapshots = requireSnapshots(options);
      const from = parseTurnIndex(url.searchParams.get("from"));
      const to = parseTurnIndex(url.searchParams.get("to"));
      if (from === null || to === null) {
        return Response.json(
          { error: "from and to query params are required turn indexes" },
          { status: 400 },
        );
      }
      await options.sessions.getSession(sessionId, context?.orgId);
      return Response.json({ diff: await snapshots.diff(sessionId, from, to) });
    }

    if (
      request.method === "GET" &&
      parts.length === 4 &&
      parts[2] === "snapshots"
    ) {
      const turnIndex = parseTurnIndex(parts[3]);
      if (turnIndex === null) return notFound();
      const snapshots = requireSnapshots(options);
      await options.sessions.getSession(sessionId, context?.orgId);
      return Response.json({
        files: Object.fromEntries(
          await snapshots.restore(sessionId, turnIndex),
        ),
      });
    }

    if (
      request.method === "POST" &&
      parts.length === 5 &&
      parts[2] === "snapshots" &&
      parts[4] === "restore"
    ) {
      const turnIndex = parseTurnIndex(parts[3]);
      if (turnIndex === null) return notFound();
      const snapshots = requireSnapshots(options);
      await options.sessions.getSession(sessionId, context?.orgId);
      await snapshots.restoreToSandbox(sessionId, turnIndex);
      return Response.json({ ok: true });
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
          .addMessage(sessionId, body.content, context?.userId, context?.orgId)
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
      const result = await compaction.compact(sessionId);
      return Response.json({
        compacted: result !== null,
        summary: result?.summary.content ?? null,
      });
    }

    if (
      request.method === "POST" &&
      parts.length === 3 &&
      parts[2] === "review"
    ) {
      if (!options.reviewEngine) {
        return Response.json({ error: "not_supported" }, { status: 501 });
      }
      const body = reviewSchema.parse(await request.json());
      const session = await options.sessions.getSession(
        sessionId,
        context?.orgId,
      );
      return streamReview(options.reviewEngine, body.target, session.repoPath);
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
        (parts.length === 4 && parts[2] === "plans" && parts[3] === "current"))
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
      return Response.json(
        await options.sessions.listCheckpoints(
          sessionId,
          readPageOptions(url.searchParams),
        ),
      );
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

    if (
      request.method === "PATCH" &&
      parts.length === 3 &&
      parts[2] === "config"
    ) {
      if (!options.sessions.updateConfig) {
        return Response.json({ error: "not_supported" }, { status: 501 });
      }
      const body = patchConfigSchema.parse(await request.json());
      const configUpdate: { effort?: EffortLevel } = {};
      if (body.effort !== undefined) configUpdate.effort = body.effort;
      const updated = await options.sessions.updateConfig(
        sessionId,
        configUpdate,
      );
      return Response.json(updated);
    }

    if (
      request.method === "GET" &&
      parts.length === 3 &&
      parts[2] === "context-stats"
    ) {
      if (!options.sessions.getContextStats) {
        return Response.json({
          systemPrompt: 0,
          memory: 0,
          repoMap: 0,
          messages: 0,
          lastTurnTokens: 0,
          budget: CONTEXT_TOKEN_BUDGET,
          available: CONTEXT_TOKEN_BUDGET,
        });
      }
      const stats = await options.sessions.getContextStats(
        sessionId,
        context?.orgId,
      );
      const memory = options.conversations?.getMemoryTokenCount?.(sessionId);
      const systemPrompt =
        options.conversations?.getSystemPromptTokenCount?.(sessionId);
      return Response.json(
        mergeLiveContextStats(stats, {
          ...(memory === undefined ? {} : { memory }),
          ...(systemPrompt === undefined ? {} : { systemPrompt }),
        }),
      );
    }

    if (request.method === "GET" && parts.length === 3 && parts[2] === "diff") {
      if (!options.sessions.getDiff) {
        return Response.json({ error: "not_supported" }, { status: 501 });
      }
      const rawFrom = url.searchParams.get("from");
      const rawTo = url.searchParams.get("to");
      if (rawFrom && !GIT_REF_RE.test(rawFrom)) {
        return Response.json({ error: "invalid from ref" }, { status: 400 });
      }
      if (rawTo && !GIT_REF_RE.test(rawTo)) {
        return Response.json({ error: "invalid to ref" }, { status: 400 });
      }
      const from = rawFrom ?? undefined;
      const to = rawTo ?? undefined;
      const session = await options.sessions.getSession(
        sessionId,
        context?.orgId,
      );
      if (!session.startCheckpointHash && !from) {
        return Response.json(
          { error: "Session was created before diff tracking" },
          { status: 400 },
        );
      }
      const diff = await options.sessions.getDiff(
        sessionId,
        from ?? session.startCheckpointHash ?? undefined,
        to,
      );
      return new Response(diff, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (
      request.method === "GET" &&
      parts.length === 3 &&
      parts[2] === "export"
    ) {
      const session = await options.sessions.getSession(
        sessionId,
        context?.orgId,
      );
      const fmt = url.searchParams.get("format");
      const format = fmt === "json" ? "json" : "markdown";
      const conversations = options.conversations;
      const msgPage: { messages: ExportMessage[] } = conversations
        ? ((await conversations.getMessages(
            sessionId,
            { limit: EXPORT_MESSAGE_LIMIT },
            context?.orgId,
          )) as { messages: ExportMessage[] })
        : { messages: [] };
      const truncated = msgPage.messages.length >= EXPORT_MESSAGE_LIMIT;
      const exported =
        format === "json"
          ? JSON.stringify(
              { session, messages: msgPage.messages, truncated },
              null,
              2,
            )
          : formatSessionMarkdown(session, msgPage.messages, {
              truncated,
              messageLimit: EXPORT_MESSAGE_LIMIT,
            });
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
      };
      if (truncated) headers["X-Truncated"] = "true";
      return new Response(exported, { headers });
    }

    return notFound();
  } catch (error) {
    return toErrorResponse(error, requestId, options.errorReporter);
  }
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
            return withStandardHeaders(
              Response.json({ error: "Unauthorized" }, { status: 401 }),
              request.headers.get("x-request-id") ?? crypto.randomUUID(),
              corsHeadersFor(request, options),
            );
          }
        }

        try {
          await options.sessions.getSession(parts[1], context?.orgId);
        } catch (error) {
          const requestId =
            request.headers.get("x-request-id") ?? crypto.randomUUID();
          return withStandardHeaders(
            toErrorResponse(error, requestId, options.errorReporter),
            requestId,
            corsHeadersFor(request, options),
          );
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

function requireSnapshots(options: DaemonServerOptions): DaemonSnapshots {
  if (!options.snapshots) {
    throw new Error("SnapshotController is not configured");
  }

  return options.snapshots;
}

function requirePermissions(options: DaemonServerOptions): DaemonPermissions {
  if (!options.permissions) {
    throw new Error("PermissionGate is not configured");
  }

  return options.permissions;
}

function requireMemory(options: DaemonServerOptions): DaemonMemory {
  if (!options.memory) {
    throw new Error("MemoryManager is not configured");
  }

  return options.memory;
}

function streamReview(
  reviewEngine: DaemonReviewEngine,
  target: ReviewTarget,
  repoPath: string,
): Response {
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of reviewEngine.review(target, repoPath)) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
            })}\n\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
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
        pathname === "/auth/invitations/accept" ||
        pathname === "/webhooks/stripe")) ||
    (method === "GET" && pathname === "/health")
  );
}

async function handleMemoryRequest(
  options: DaemonServerOptions,
  request: Request,
  url: URL,
  parts: string[],
  context: AuthContext | null,
): Promise<Response> {
  const memory = requireMemory(options);
  const identity = memoryIdentity(options, context);

  if (request.method === "GET" && parts.length === 1) {
    const filters = readMemoryFilters(url.searchParams);
    const all = await memory.store.listByUser(identity.userId, identity.orgId);
    const filtered = all.filter(
      (entry) =>
        (filters.type === undefined || entry.type === filters.type) &&
        (filters.pinned === undefined || entry.pinned === filters.pinned),
    );
    const offset = (filters.page - 1) * filters.limit;
    return Response.json(filtered.slice(offset, offset + filters.limit));
  }

  if (request.method === "POST" && parts.length === 1) {
    const body = memoryCreateSchema.parse(await request.json());
    const now = new Date().toISOString();
    const candidate: Memory = {
      id: crypto.randomUUID(),
      userId: identity.userId,
      orgId: identity.orgId,
      type: body.type,
      scope: identity.orgId ? "org" : "user",
      source: "manual",
      name: body.name,
      description: body.description,
      body: body.body,
      pinned: body.pinned,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await memory.store.upsertByName(candidate);
    await memory.materialize(identity.userId, identity.orgId);
    return Response.json(saved, { status: 201 });
  }

  if (
    request.method === "POST" &&
    parts.length === 2 &&
    parts[1] === "sync-from-file"
  ) {
    if (options.cloud) {
      return Response.json(
        { error: "sync-from-file is not available in cloud mode" },
        { status: 400 },
      );
    }
    const upserted = await memory.syncFromFile(
      join(homedir(), ".iquantum", "MEMORY.md"),
      identity.userId,
      identity.orgId,
    );
    return Response.json({ upserted });
  }

  if (parts.length === 2 && parts[1]) {
    const id = parts[1];

    if (request.method === "PATCH") {
      const updates = compactMemoryUpdates(
        memoryUpdateSchema.parse(await request.json()),
      );
      const updated = await memory.store.update(id, identity.userId, updates);
      if (!updated) return notFound();
      await memory.materialize(identity.userId, identity.orgId);
      return Response.json(updated);
    }

    if (request.method === "DELETE") {
      const existing = await memory.store.get(id, identity.userId);
      if (!existing) return notFound();
      await memory.store.delete(id, identity.userId);
      await memory.materialize(identity.userId, identity.orgId);
      return new Response(null, { status: 204 });
    }
  }

  return notFound();
}

function memoryIdentity(
  options: DaemonServerOptions,
  context: AuthContext | null,
): { userId: string; orgId: string | null } {
  return {
    userId: context?.userId ?? options.memoryUserId ?? "local",
    orgId: context?.orgId ?? null,
  };
}

function readMemoryFilters(params: { get(name: string): string | null }): {
  type?: Memory["type"];
  pinned?: boolean;
  page: number;
  limit: number;
} {
  const typeParam = params.get("type");
  const pinnedParam = params.get("pinned");
  const type =
    typeParam === null ? undefined : memoryTypeSchema.parse(typeParam);
  const pinned =
    pinnedParam === null ? undefined : memoryPinnedSchema.parse(pinnedParam);
  return {
    ...(type === undefined ? {} : { type }),
    ...(pinned === undefined ? {} : { pinned }),
    page: memoryPageSchema.parse(params.get("page") ?? undefined),
    limit:
      params.get("limit") === null
        ? 50
        : pageLimitSchema.parse(params.get("limit")),
  };
}

function compactMemoryUpdates(
  updates: z.infer<typeof memoryUpdateSchema>,
): Partial<Pick<Memory, "type" | "name" | "description" | "body" | "pinned">> {
  return Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as Partial<
    Pick<Memory, "type" | "name" | "description" | "body" | "pinned">
  >;
}

function readMessageLimit(value: string | null): number {
  if (value === null) {
    return 50;
  }

  return messageLimitSchema.parse(value);
}

function readPageOptions(params: { get(name: string): string | null }): {
  before?: string;
  limit: number;
} {
  const before = params.get("before");
  return {
    ...(before ? { before } : {}),
    limit:
      params.get("limit") === null
        ? 50
        : pageLimitSchema.parse(params.get("limit")),
  };
}

function withStandardHeaders(
  response: Response,
  requestId: string,
  corsHeaders: Record<string, string> | null,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  for (const [key, value] of Object.entries(corsHeaders ?? {})) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeadersFor(
  request: Request,
  options: DaemonServerOptions,
): Record<string, string> | null {
  if (!options.corsOrigins?.length) {
    return null;
  }

  const origin = request.headers.get("origin");
  if (!origin || !options.corsOrigins.includes(origin)) {
    return { Vary: "Origin" };
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-ID",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    Vary: "Origin",
  };
}

async function enforceAuthRateLimit(
  options: DaemonServerOptions,
  request: Request,
  target:
    | { endpoint: "login" | "register"; email: string }
    | { endpoint: "acceptInvite" },
): Promise<Response | null> {
  if (!options.rateLimiter) {
    return null;
  }

  const ip = clientIp(request);
  const checks =
    target.endpoint === "login"
      ? [
          { key: `auth:login:ip:${ip}`, options: AUTH_LIMITS.loginIp },
          {
            key: `auth:login:email:${target.email.trim().toLowerCase()}`,
            options: AUTH_LIMITS.loginEmail,
          },
        ]
      : target.endpoint === "register"
        ? [{ key: `auth:register:ip:${ip}`, options: AUTH_LIMITS.registerIp }]
        : [
            {
              key: `auth:accept-invite:ip:${ip}`,
              options: AUTH_LIMITS.acceptInviteIp,
            },
          ];

  for (const check of checks) {
    const result = await options.rateLimiter.consume(check.key, check.options);
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((result.resetAt - Date.now()) / 1000),
      );
      return Response.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSeconds),
            "RateLimit-Limit": String(check.options.limit),
            "RateLimit-Remaining": String(result.remaining),
            "RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
          },
        },
      );
    }
  }

  return null;
}

const AUTH_LIMITS = {
  loginIp: { limit: 20, windowMs: 60_000 },
  loginEmail: { limit: 5, windowMs: 15 * 60_000 },
  registerIp: { limit: 5, windowMs: 60 * 60_000 },
  acceptInviteIp: { limit: 10, windowMs: 60 * 60_000 },
} satisfies Record<string, RateLimitOptions>;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",", 1)[0]?.trim() || "unknown";
  }

  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    "local"
  );
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

function mergeLiveContextStats(
  stats: ContextStats,
  live: Partial<Pick<ContextStats, "memory" | "systemPrompt">>,
): ContextStats {
  const merged = {
    ...stats,
    ...(live.memory === undefined ? {} : { memory: live.memory }),
    ...(live.systemPrompt === undefined
      ? {}
      : { systemPrompt: live.systemPrompt }),
  };
  const used =
    merged.systemPrompt + merged.memory + merged.repoMap + merged.messages;
  return {
    ...merged,
    available: Math.max(0, merged.budget - used),
  };
}

function parseTurnIndex(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function toErrorResponse(
  error: unknown,
  requestId: string,
  errorReporter?: ErrorReporter,
): Response {
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

  if (error instanceof InvalidCheckpointCursorError) {
    return Response.json(
      { error: "invalid_checkpoint_cursor" },
      { status: 400 },
    );
  }

  if (
    error instanceof InvalidInviteTokenError ||
    error instanceof InvalidMemberCursorError
  ) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  if (
    error instanceof SessionNotLiveError ||
    error instanceof InvalidTransitionError
  ) {
    const code =
      error instanceof SessionNotLiveError
        ? "session_not_live"
        : "invalid_session_state";
    logger.warn({
      msg: "client state conflict",
      requestId,
      error: error.message,
    });
    return Response.json({ error: code }, { status: 409 });
  }

  errorReporter?.captureException(error, { requestId });
  logger.error({
    msg: "unhandled request error",
    requestId,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return Response.json({ error: "internal_error" }, { status: 500 });
}

function toErrorFrame(error: unknown): { type: "error"; message: string } {
  if (error instanceof SessionNotLiveError) {
    return { type: "error", message: "session_not_live" };
  }

  if (error instanceof InvalidTransitionError) {
    return { type: "error", message: "invalid_session_state" };
  }

  return {
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}
