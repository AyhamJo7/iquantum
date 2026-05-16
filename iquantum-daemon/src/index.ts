import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@iquantum/config";
import { AnthropicProvider, LLMRouter } from "@iquantum/llm";
import { SandboxManager } from "@iquantum/sandbox";
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
import { PermissionGate } from "./permission-gate";
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
initializeSchema(db);

const sessionStore = new SqliteSessionStore(db);
const pivStore = new SqlitePIVStore(db);
const conversationStore = new SqliteConversationStore(db);
const checkpointStore = new SqliteGitCheckpointStore(db);
const sandbox = new SandboxManager();
const provider = new AnthropicProvider({ apiKey: config.anthropicApiKey });
const maxInputTokens = 32_000;
const llmRouter = new LLMRouter({
  architect: { provider, model: config.architectModel },
  editor: { provider, model: config.editorModel },
  maxInputTokens,
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
};
const compaction = new CompactionService({
  store: conversationStore,
  completer: conversationCompleter,
  streams,
  modelContextWindow: maxInputTokens,
});
const conversations = new ConversationController({
  store: conversationStore,
  completer: conversationCompleter,
  streams,
  compactor: compaction,
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
