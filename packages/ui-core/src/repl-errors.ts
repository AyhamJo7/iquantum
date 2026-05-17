export const DAEMON_DISCONNECTED_MESSAGE =
  "Daemon disconnected. Run `iq daemon start` to reconnect.";

export function formatREPLError(error: unknown): string {
  if (isDaemonNotRunning(error)) {
    return DAEMON_DISCONNECTED_MESSAGE;
  }

  return error instanceof Error ? error.message : String(error);
}

function isDaemonNotRunning(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const errno = error as NodeJS.ErrnoException;
  return (
    errno.code === "ENOENT" ||
    errno.code === "ECONNREFUSED" ||
    errno.code === "FailedToOpenSocket" ||
    error.message.includes("Was there a typo in the url or port?")
  );
}
