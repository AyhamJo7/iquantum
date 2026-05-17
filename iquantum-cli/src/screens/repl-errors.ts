import { isDaemonNotRunning } from "../client";

export const DAEMON_DISCONNECTED_MESSAGE =
  "Daemon disconnected. Run `iq daemon start` to reconnect.";

export function formatREPLError(error: unknown): string {
  if (isDaemonNotRunning(error)) {
    return DAEMON_DISCONNECTED_MESSAGE;
  }

  return error instanceof Error ? error.message : String(error);
}
