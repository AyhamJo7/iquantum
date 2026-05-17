import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@iquantum/config";
import {
  AnthropicProvider,
  LLMRouter,
  OpenAICompatibleProvider,
} from "@iquantum/llm";
import { SandboxManager } from "@iquantum/sandbox";
import type { LLMProvider, McpTool } from "@iquantum/types";
import { CompactionService } from "./compaction-service";
import { ConversationController } from "./conversation-controller";
import { initializeSchema } from "./db/schema";
import {
  SqliteConversationStore,
  SqliteGitCheckpointStore,
  SqlitePIVStore,
  SqliteSessionStore,
} from "./db/stores";
import { logger } from "./logger";
import { McpClient, McpRegistry } from "./mcp-client";
import { PermissionGate } from "./permission-gate";
import type { DaemonMcpRegistry } from "./server";
import { createDaemonServer } from "./server";
import { SessionController } from "./session-controller";
import { StreamController } from "./stream-controller";

const config = loadConfig();
const stateDir = dirname(config.socketPath);
const pidPath = join(stateDir, "daemon.pid");
const dbPath = join(stateDir, "iquantum.sqlite");

await mkdir(stateDir, { recursive: true });
await rm(config.socketPath, { force: true });

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
initializeSchema(db);

const sessionStore = new SqliteSessionStore(db);
const pivStore = new SqlitePIVStore(db);
const conversationStore = new SqliteConversationStore(db);
const checkpointStore = new SqliteGitCheckpointStore(db);
const sandbox = new SandboxManager({
  execTimeoutMs: config.execTimeoutMs,
  image: config.sandboxImage,
});
await sandbox.ensureImageReady((msg) => logger.info({ msg }));
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
    db.query("SELECT 1").get();
    dbOk = true;
  } catch {}

  try {
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    dockerOk = exitCode === 0;
  } catch {}

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
});

await writeFile(pidPath, String(process.pid), "utf8");

logger.info({
  msg: "daemon started",
  socket: config.socketPath,
  pid: process.pid,
});

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
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
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
