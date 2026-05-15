import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

function defaultDaemonEntry(): string {
  // daemon.ts lives at <repo>/iquantum-cli/src/commands/daemon.ts
  // Three levels up reaches the repo root, then into iquantum-daemon.
  const cliDir = dirname(fileURLToPath(import.meta.url));
  return resolve(cliDir, "../../../iquantum-daemon/src/index.ts");
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
  const proc = spawn(process.execPath, ["run", entry], {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
    env: process.env,
  });
  proc.unref();
  await logFd.close();
  writer.writeln(`daemon started (pid ${proc.pid ?? "?"})`);
  writer.writeln(`logs: ${log}`);
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
