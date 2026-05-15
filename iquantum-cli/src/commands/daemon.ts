import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
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
  const cliDir = dirname(fileURLToPath(import.meta.url));
  return resolve(cliDir, "../../iquantum-daemon/src/index.ts");
}

function pidPath(socketPath: string): string {
  return join(dirname(socketPath), "daemon.pid");
}

export async function startDaemon(
  options: DaemonStartOptions,
  writer: Writer,
): Promise<void> {
  const entry = options.daemonEntry ?? defaultDaemonEntry();
  const proc = spawn("bun", ["run", entry], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  proc.unref();
  writer.writeln(`daemon started (pid ${proc.pid ?? "?"})`);
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
