import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfigFileSync } from "@iquantum/config";
import type { DaemonClient } from "../client";

export interface DaemonStartOptions {
  socketPath: string;
  /** Override the daemon entry point (default: resolved relative to CLI). */
  daemonEntry?: string;
}

export interface DaemonStopOptions {
  socketPath: string;
}

export interface DaemonStatusOptions {
  client: Pick<DaemonClient, "health">;
}

export interface Writer {
  writeln(line: string): void;
}

export function resolveDaemonEntry(
  cliDir: string,
  sourceExists: (path: string) => boolean = existsSync,
): string {
  const sourceEntry = resolve(cliDir, "../../../iquantum-daemon/src/index.ts");

  if (sourceExists(sourceEntry)) {
    return sourceEntry;
  }

  return resolve(cliDir, "daemon.js");
}

function defaultDaemonEntry(): string {
  return resolveDaemonEntry(dirname(fileURLToPath(import.meta.url)));
}

function logPath(socketPath: string): string {
  return join(dirname(socketPath), "daemon.log");
}

function pidPath(socketPath: string): string {
  return join(dirname(socketPath), "daemon.pid");
}

export async function startDaemon(
  options: DaemonStartOptions,
  writer: Writer,
): Promise<void> {
  const entry = options.daemonEntry ?? defaultDaemonEntry();
  const stateDir = dirname(options.socketPath);
  await mkdir(stateDir, { recursive: true });
  const log = logPath(options.socketPath);
  const logFd = await open(log, "a");
  const runArgs = ["run", entry];

  const proc = spawn(process.execPath, runArgs, {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
    env: daemonChildEnv(),
  });
  proc.unref();
  await logFd.close();
  writer.writeln(`daemon started (pid ${proc.pid ?? "?"})`);
  writer.writeln(`logs: ${log}`);
}

export function daemonChildEnv(
  configDir = join(homedir(), ".iquantum"),
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...readConfigFileSync(configDir),
    ...env,
  };
}

export async function stopDaemon(
  options: DaemonStopOptions,
  writer: Writer,
): Promise<void> {
  const pid = await readPid(pidPath(options.socketPath));

  if (!pid) {
    writer.writeln("daemon is not running");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    // Clean up the PID file ourselves since the daemon may have already exited
    await rm(pidPath(options.socketPath), { force: true });
    writer.writeln(`daemon stopped (pid ${pid})`);
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      writer.writeln("daemon is not running");
      await rm(pidPath(options.socketPath), { force: true });
    } else {
      throw error;
    }
  }
}

export async function daemonStatus(
  options: DaemonStatusOptions,
  writer: Writer,
): Promise<void> {
  try {
    await options.client.health();
    writer.writeln("daemon is running");
  } catch {
    writer.writeln("daemon is not running");
  }
}

async function readPid(path: string): Promise<number | null> {
  try {
    const text = await readFile(path, "utf8");
    const pid = parseInt(text.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
