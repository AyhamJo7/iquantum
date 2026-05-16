import type { DaemonClient } from "./client";
import { isDaemonNotRunning } from "./client";

export interface EnsureDaemonOptions {
  attempts?: number;
  pollIntervalMs?: number;
}

export async function ensureDaemonReady(
  client: Pick<DaemonClient, "health">,
  launchDaemon: () => Promise<void>,
  sleep: (delayMs: number) => Promise<void> = defaultSleep,
  options: EnsureDaemonOptions = {},
): Promise<void> {
  try {
    await client.health();
    return;
  } catch (error) {
    if (!isDaemonNotRunning(error)) {
      throw error;
    }
  }

  await launchDaemon();
  const attempts = options.attempts ?? 50;
  const pollIntervalMs = options.pollIntervalMs ?? 200;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(pollIntervalMs);

    try {
      await client.health();
      return;
    } catch (error) {
      if (!isDaemonNotRunning(error)) {
        throw error;
      }
    }
  }

  throw new Error("daemon did not become ready within 10 seconds");
}

export async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
