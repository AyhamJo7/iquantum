import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@iquantum/config";
import { AnthropicProvider, LLMRouter } from "@iquantum/llm";
import { SandboxManager } from "@iquantum/sandbox";
import { initializeSchema } from "./db/schema";
import {
  SqliteGitCheckpointStore,
  SqlitePIVStore,
  SqliteSessionStore,
} from "./db/stores";
import { logger } from "./logger";
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
const checkpointStore = new SqliteGitCheckpointStore(db);
const sandbox = new SandboxManager();
const sessions = new SessionController({
  sessionStore,
  pivStore,
  gitCheckpointStore: checkpointStore,
  sandbox,
  maxRetries: config.maxRetries,
  llmRouterFactory: () => {
    const provider = new AnthropicProvider({ apiKey: config.anthropicApiKey });

    return new LLMRouter({
      architect: { provider, model: config.architectModel },
      editor: { provider, model: config.editorModel },
      maxInputTokens: 32_000,
    });
  },
});
const streams = new StreamController(sessions);

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
  healthCheck,
});

await writeFile(pidPath, String(process.pid), "utf8");

logger.info({
  msg: "daemon started",
  socket: config.socketPath,
  pid: process.pid,
});

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info({ msg: "shutdown", signal });
  streams.closeAll();
  await server.stop(true);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  await rm(config.socketPath, { force: true });
  await rm(pidPath, { force: true });
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
