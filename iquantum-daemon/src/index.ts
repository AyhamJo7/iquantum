import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@iquantum/config";
import { countTokens } from "@iquantum/context-window";
import { SandboxFileTools } from "@iquantum/file-tools";
import { HookLoader, HookRunner } from "@iquantum/hooks";
import {
  AnthropicProvider,
  LLMRouter,
  OpenAICompatibleProvider,
  TokenBudgetExceededError,
} from "@iquantum/llm";
import { MemoryManager } from "@iquantum/memory";
import { SandboxManager as LocalSandboxManager } from "@iquantum/sandbox";
import { SnapshotStore } from "@iquantum/snapshots";
import type { LLMProvider, McpTool } from "@iquantum/types";
import { WebToolExecutor } from "@iquantum/web-tools";
import Redis from "ioredis";
import { AuthStore } from "./auth/auth-store";
import { JwtService } from "./auth/jwt-service";
import { BillingTracker } from "./billing-tracker";
import { CompactionService } from "./compaction-service";
import { ConversationController } from "./conversation-controller";
import { createDbAdapter, PostgresAdapter, SqliteAdapter } from "./db/adapter";
import { initializePostgresSchema, initializeSchema } from "./db/schema";
import {
  AdapterConversationStore,
  AdapterFileSnapshotStore,
  AdapterGitCheckpointStore,
  AdapterHookRunStore,
  AdapterMemoryStore,
  AdapterPIVStore,
  AdapterSessionStore,
} from "./db/stores";
import { createErrorReporter } from "./error-reporter";
import { logger } from "./logger";
import { McpClient, McpRegistry } from "./mcp-client";
import { PermissionGate } from "./permission-gate";
import { InMemoryRateLimiter, RedisRateLimiter } from "./rate-limit";
import { ReviewEngine } from "./review-engine";
import { createSandboxManager } from "./sandbox-factory";
import type { DaemonMcpRegistry } from "./server";
import { createDaemonServer, createTcpDaemonServer } from "./server";
import { SessionController } from "./session-controller";
import { SnapshotController } from "./snapshot-controller";
import { StreamController } from "./stream-controller";
import { StripeClient } from "./stripe-client";

const config = loadConfig();
const errorReporter = createErrorReporter(config.sentryDsn);
const stateDir = dirname(config.socketPath);
const pidPath = join(stateDir, "daemon.pid");
const dbPath = join(stateDir, "iquantum.sqlite");

await mkdir(stateDir, { recursive: true });
await mkdir(config.hooksDir, { recursive: true });
await mkdir(config.skillsDir, { recursive: true });
await rm(config.socketPath, { force: true });

const dbAdapter = createDbAdapter(config.databaseUrl ?? `file:${dbPath}`);
if (dbAdapter instanceof SqliteAdapter) {
  dbAdapter.db.exec("PRAGMA journal_mode = WAL;");
  dbAdapter.db.exec("PRAGMA foreign_keys = ON;");
  initializeSchema(dbAdapter.db);
} else if (dbAdapter instanceof PostgresAdapter) {
  await initializePostgresSchema(dbAdapter);
}
const sessionStore = new AdapterSessionStore(dbAdapter);
const pivStore = new AdapterPIVStore(dbAdapter);
const conversationStore = new AdapterConversationStore(dbAdapter);
const checkpointStore = new AdapterGitCheckpointStore(dbAdapter);
const fileSnapshotStore = new AdapterFileSnapshotStore(dbAdapter);
const hookRunStore = new AdapterHookRunStore(dbAdapter);
const memoryStore = new AdapterMemoryStore(dbAdapter);
const hooks = await HookLoader.load(config.hooksDir, config.hookTimeoutMs);
const hookRunner = new HookRunner(hooks, hookRunStore, () =>
  new Date().toISOString(),
);
const stopHookWatcher = HookLoader.watch(
  config.hooksDir,
  config.hookTimeoutMs,
  (newHooks) => hookRunner.updateHooks(newHooks),
);
const memoryManager = new MemoryManager(
  {
    store: memoryStore,
    countTokens: (text) => countTokens([{ content: text }]),
  },
  {
    budgetTokens: config.memoryTokens,
    memoriesDir: stateDir,
  },
);
const authStore = config.cloud ? new AuthStore(dbAdapter) : undefined;
const jwtService =
  config.cloud && config.jwtSecret
    ? new JwtService(config.jwtSecret)
    : undefined;
const stripeClient = config.stripeSecretKey
  ? new StripeClient(config.stripeSecretKey)
  : undefined;
const billingTracker = config.cloud
  ? new BillingTracker(dbAdapter, stripeClient ?? null)
  : undefined;
const redis =
  config.cloud && config.redisUrl
    ? new Redis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
      })
    : undefined;
await redis?.connect();
const rateLimiter = config.cloud
  ? redis
    ? new RedisRateLimiter(redis)
    : new InMemoryRateLimiter()
  : undefined;
const webSearchRateLimiter = config.webTools
  ? (rateLimiter ?? new InMemoryRateLimiter())
  : undefined;
const sandbox = createSandboxManager(config);
if (sandbox instanceof LocalSandboxManager) {
  await sandbox.ensureImageReady((msg) => logger.info({ msg }));
}
const snapshots = new SnapshotController({
  store: new SnapshotStore({ store: fileSnapshotStore }),
  sandbox,
});
const provider: LLMProvider =
  config.provider === "openai"
    ? new OpenAICompatibleProvider({
        apiKey: config.providerApiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      })
    : new AnthropicProvider({ apiKey: config.providerApiKey });
logger.info({
  msg: "provider",
  provider: config.provider,
  baseUrl: config.baseUrl ?? "default",
});
if (config.provider === "openai") {
  logger.warn({
    msg: "extended thinking unavailable for openai-compatible provider",
  });
}
const maxInputTokens = 32_000;
const llmRouter = new LLMRouter({
  architect: { provider, model: config.architectModel },
  editor: { provider, model: config.editorModel },
  maxInputTokens,
  supportsThinking: config.provider !== "openai",
});
const fileTools = config.fileTools
  ? new SandboxFileTools(config.fileToolMaxBytes)
  : undefined;
const webTools = config.webTools
  ? new WebToolExecutor({
      enabled: config.webTools,
      provider: config.searchProvider,
      ...(config.braveApiKey ? { braveApiKey: config.braveApiKey } : {}),
      ...(config.tavilyApiKey ? { tavilyApiKey: config.tavilyApiKey } : {}),
    })
  : undefined;
let streams: StreamController;
const permissions = new PermissionGate({
  publish(sessionId, frame) {
    streams.publish(sessionId, frame);
  },
});
const conversationCompleter = {
  complete: llmRouter.complete.bind(llmRouter, "plan"),
  ...(provider.completeWithTools
    ? {
        completeWithTools: (
          messages: Parameters<typeof llmRouter.completeWithTools>[1],
          tools: Parameters<typeof llmRouter.completeWithTools>[2],
          options: Parameters<typeof llmRouter.completeWithTools>[3],
        ) => llmRouter.completeWithTools("plan", messages, tools, options),
      }
    : {}),
};
const compaction = new CompactionService({
  store: conversationStore,
  completer: conversationCompleter,
  streams: {
    publish(sessionId, frame) {
      streams.publish(sessionId, frame);
    },
  },
  modelContextWindow: maxInputTokens,
  autoThreshold: config.compactionAutoThreshold,
  keepTurns: config.compactionKeepTurns,
  maxSummaryTokens: config.compactionSummaryTokens,
});
const sessions = new SessionController({
  sessionStore,
  pivStore,
  gitCheckpointStore: checkpointStore,
  sandbox,
  maxRetries: config.maxRetries,
  llmRouterFactory: () => llmRouter,
  permissionGate: permissions,
  hookRunner,
  compactionService: compaction,
  snapshotStore: snapshots,
  snapshotKeepTurns: config.snapshotMaxTurns,
  // Lazy reference — conversations is assigned below after streams is ready.
  conversations: {
    clearSession: (sessionId) => conversations.clearSession(sessionId),
  },
  ...(config.fileTools ? { fileToolMaxBytes: config.fileToolMaxBytes } : {}),
  ...(webTools ? { webTools } : {}),
  ...(webSearchRateLimiter ? { webSearchRateLimiter } : {}),
  memoryManager,
  memoryUserId: "local",
});
streams = new StreamController(sessions);
const reviewModel = config.reviewModel ?? config.architectModel;
const reviewEngine = new ReviewEngine({
  completer: {
    async *complete(messages, options) {
      const inputTokens = await provider.countTokens(messages, reviewModel);
      if (inputTokens > maxInputTokens) {
        throw new TokenBudgetExceededError(inputTokens, maxInputTokens);
      }
      yield* provider.complete(messages, {
        model: reviewModel,
        maxTokens: options.maxTokens,
      });
    },
  },
});

const mcpClients = config.mcpServers.map((srv) => new McpClient(srv));
const mcpRegistry =
  mcpClients.length > 0 ? new McpRegistry(mcpClients) : undefined;

const daemonMcpRegistry: DaemonMcpRegistry | undefined = mcpRegistry
  ? {
      async listAllTools() {
        const tools: McpTool[] = (await mcpRegistry.listTools()) as McpTool[];
        return tools.map((t) => {
          const sepIdx = t.name.indexOf("__");
          return {
            serverName: sepIdx !== -1 ? t.name.slice(0, sepIdx) : "mcp",
            name: sepIdx !== -1 ? t.name.slice(sepIdx + 2) : t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          };
        });
      },
    }
  : undefined;

const conversations = new ConversationController({
  store: conversationStore,
  completer: conversationCompleter,
  streams,
  compactor: compaction,
  ...(mcpRegistry ? { mcpClient: mcpRegistry } : {}),
  ...(fileTools ? { fileTools: { tools: fileTools, sandbox } } : {}),
  ...(webTools ? { webTools } : {}),
  ...(webSearchRateLimiter ? { webSearchRateLimiter } : {}),
  permissionChecker: permissions,
  memoryManager,
  memoryUserId: "local",
  autoMemory: config.autoMemory,
  hookRunner,
  snapshotStore: snapshots,
});

async function healthCheck(): Promise<{
  db: boolean;
  docker: boolean;
  redis?: boolean;
}> {
  let dbOk = false;
  let dockerOk = false;
  let redisOk: boolean | undefined;

  try {
    await dbAdapter.first("SELECT 1 AS ok");
    dbOk = true;
  } catch {}

  if (config.cloud) {
    dockerOk = true;
    try {
      redisOk = redis ? (await redis.ping()) === "PONG" : false;
    } catch {
      redisOk = false;
    }
  } else {
    try {
      const proc = Bun.spawn(["docker", "info"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      dockerOk = exitCode === 0;
    } catch {}
  }

  return {
    db: dbOk,
    docker: dockerOk,
    ...(redisOk === undefined ? {} : { redis: redisOk }),
  };
}

const server = createDaemonServer({
  socketPath: config.socketPath,
  sessions,
  streams,
  conversations,
  compaction,
  snapshots,
  permissions,
  reviewEngine,
  ...(daemonMcpRegistry ? { mcpRegistry: daemonMcpRegistry } : {}),
  hooks: hookRunner,
  memory: memoryManager,
  memoryUserId: "local",
  healthCheck,
  cloud: config.cloud,
  ...(authStore ? { authStore } : {}),
  ...(jwtService ? { jwtService } : {}),
  ...(stripeClient ? { stripeClient } : {}),
  ...(billingTracker ? { billingTracker } : {}),
  ...(rateLimiter ? { rateLimiter } : {}),
  ...(config.corsOrigins ? { corsOrigins: config.corsOrigins } : {}),
  ...(errorReporter ? { errorReporter } : {}),
  ...(config.stripeWebhookSecret
    ? { stripeWebhookSecret: config.stripeWebhookSecret }
    : {}),
});
const tcpServer = createTcpDaemonServer(
  {
    socketPath: config.socketPath,
    sessions,
    streams,
    conversations,
    compaction,
    snapshots,
    permissions,
    reviewEngine,
    ...(daemonMcpRegistry ? { mcpRegistry: daemonMcpRegistry } : {}),
    hooks: hookRunner,
    memory: memoryManager,
    memoryUserId: "local",
    healthCheck,
    cloud: config.cloud,
    ...(authStore ? { authStore } : {}),
    ...(jwtService ? { jwtService } : {}),
    ...(stripeClient ? { stripeClient } : {}),
    ...(billingTracker ? { billingTracker } : {}),
    ...(rateLimiter ? { rateLimiter } : {}),
    ...(config.corsOrigins ? { corsOrigins: config.corsOrigins } : {}),
    ...(errorReporter ? { errorReporter } : {}),
    ...(config.stripeWebhookSecret
      ? { stripeWebhookSecret: config.stripeWebhookSecret }
      : {}),
  },
  config.tcpPort,
);

await writeFile(pidPath, String(process.pid), "utf8");

logger.info({
  msg: "daemon started",
  socket: config.socketPath,
  pid: process.pid,
});
logger.info({ msg: "tcp", port: config.tcpPort });

let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ msg: "shutdown", reason, exitCode });
  permissions.drainAll();
  streams.closeAll();
  stopHookWatcher();
  await mcpRegistry?.closeAll();
  await errorReporter?.flush?.();
  await server.stop(true);
  await tcpServer.stop(true);
  await redis?.quit();
  if (dbAdapter instanceof SqliteAdapter) {
    dbAdapter.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }
  await dbAdapter.close();
  await rm(config.socketPath, { force: true });
  await rm(pidPath, { force: true });
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (reason) => {
  errorReporter?.captureException(reason, { source: "unhandledRejection" });
  logger.error({
    msg: "unhandled rejection",
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  void shutdown("unhandledRejection", 1);
});
