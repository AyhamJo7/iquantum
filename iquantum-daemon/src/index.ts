import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "@iquantum/config";
import { initializeSchema } from "./db/schema";

const config = loadConfig();
const stateDir = dirname(config.socketPath);
const pidPath = join(stateDir, "daemon.pid");
const dbPath = join(stateDir, "iquantum.sqlite");

await mkdir(stateDir, { recursive: true });
await rm(config.socketPath, { force: true });

const db = new Database(dbPath);
initializeSchema(db);

const server = Bun.serve({
  unix: config.socketPath,
  routes: {
    "/health": {
      GET: () => Response.json({ ok: true }),
    },
  },
  fetch() {
    return new Response("Not Found", { status: 404 });
  },
});

await writeFile(pidPath, String(process.pid), "utf8");

console.log(`iquantum daemon listening on ${config.socketPath}`);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`received ${signal}; shutting down`);
  server.stop(true);
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
