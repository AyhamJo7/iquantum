import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@iquantum/config";
import {
  AnthropicProvider,
  LLMRouter,
  OpenAICompatibleProvider,
} from "@iquantum/llm";
import { SandboxManager as LocalSandboxManager } from "@iquantum/sandbox";
import type { LLMProvider, McpTool } from "@iquantum/types";
import { AuthStore } from "./auth/auth-store";
import { JwtService } from "./auth/jwt-service";
import { BillingTracker } from "./billing-tracker";
import { CompactionService } from "./compaction-service";
import { ConversationController } from "./conversation-controller";
import { createDbAdapter, PostgresAdapter, SqliteAdapter } from "./db/adapter";
import { initializePostgresSchema, initializeSchema } from "./db/schema";
import {
  AdapterConversationStore,
  AdapterGitCheckpointStore,
  AdapterPIVStore,
  AdapterSessionStore,
} from "./db/stores";
import { logger } from "./logger";
import { McpClient, McpRegistry } from "./mcp-client";
import { PermissionGate } from "./permission-gate";
import { createSandboxManager } from "./sandbox-factory";
import type { DaemonMcpRegistry } from "./server";
import { createDaemonServer, createTcpDaemonServer } from "./server";
import { SessionController } from "./session-controller";
import { StreamController } from "./stream-controller";
import { StripeClient } from "./stripe-client";

const config = loadConfig();
const stateDir = dirname(config.socketPath);
const pidPath = join(stateDir, "daemon.pid");
const dbPath = join(stateDir, "iquantum.sqlite");

await mkdir(stateDir, { recursive: true });
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
const sandbox = createSandboxManager(config);
if (sandbox instanceof LocalSandboxManager) {
  await sandbox.ensureImageReady((msg) => logger.info({ msg }));
}
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
let streams: StreamController;
const permissions = new PermissionGate({
  publish(sessionId, frame) {
    streams.publish(sessionId, frame);
  },
});
const sessions = new SessionController({
  sessionStore,
  pivStore,
  gitCheckpointStore: checkpointStore,
  sandbox,
  maxRetries: config.maxRetries,
  llmRouterFactory: () => llmRouter,
  permissionGate: permissions,
});
streams = new StreamController(sessions);
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
  streams,
  modelContextWindow: maxInputTokens,
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
  permissionChecker: permissions,
});

async function healthCheck(): Promise<{ db: boolean; docker: boolean }> {
  let dbOk = false;
  let dockerOk = false;

  try {
    await dbAdapter.first("SELECT 1 AS ok");
    dbOk = true;
  } catch {}

  if (config.cloud) {
    dockerOk = true;
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

  return { db: dbOk, docker: dockerOk };
}

const server = createDaemonServer({
  socketPath: config.socketPath,
  sessions,
  streams,
  conversations,
  compaction,
  permissions,
  ...(daemonMcpRegistry ? { mcpRegistry: daemonMcpRegistry } : {}),
  healthCheck,
  cloud: config.cloud,
  ...(authStore ? { authStore } : {}),
  ...(jwtService ? { jwtService } : {}),
  ...(stripeClient ? { stripeClient } : {}),
  ...(billingTracker ? { billingTracker } : {}),
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
    permissions,
    ...(daemonMcpRegistry ? { mcpRegistry: daemonMcpRegistry } : {}),
    healthCheck,
    cloud: config.cloud,
    ...(authStore ? { authStore } : {}),
    ...(jwtService ? { jwtService } : {}),
    ...(stripeClient ? { stripeClient } : {}),
    ...(billingTracker ? { billingTracker } : {}),
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
  await mcpRegistry?.closeAll();
  await server.stop(true);
  await tcpServer.stop(true);
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
  logger.error({
    msg: "unhandled rejection",
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  void shutdown("unhandledRejection", 1);
});
