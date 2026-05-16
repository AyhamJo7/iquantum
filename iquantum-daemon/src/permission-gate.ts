export interface PermissionPublisher {
  publish(
    sessionId: string,
    frame: {
      type: "permission_request";
      requestId: string;
      tool: string;
      input: unknown;
    },
  ): void;
}

export interface PermissionRequestOptions {
  autoApprove?: boolean;
  timeoutMs?: number;
}

export class PermissionRequestNotFoundError extends Error {
  constructor(
    readonly sessionId: string,
    readonly requestId: string,
  ) {
    super(`Unknown permission request ${requestId} for session ${sessionId}`);
    this.name = "PermissionRequestNotFoundError";
  }
}

export class PermissionGate {
  readonly #publisher: PermissionPublisher;
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<string, PendingPermission>();

  constructor(
    publisher: PermissionPublisher,
    options: { defaultTimeoutMs?: number } = {},
  ) {
    this.#publisher = publisher;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000;
  }

  requestPermission(
    sessionId: string,
    requestId: string,
    tool: string,
    input: unknown,
    options: PermissionRequestOptions = {},
  ): Promise<boolean> {
    if (options.autoApprove) {
      return Promise.resolve(true);
    }

    const key = permissionKey(sessionId, requestId);

    if (this.#pending.has(key)) {
      throw new Error(
        `Permission request ${requestId} is already pending for session ${sessionId}`,
      );
    }

    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;

    const result = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(key);
        resolve(false);
      }, timeoutMs);

      this.#pending.set(key, { resolve, timeout });
    });

    this.#publisher.publish(sessionId, {
      type: "permission_request",
      requestId,
      tool,
      input,
    });

    return result;
  }

  drainAll(): void {
    for (const [key, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
      this.#pending.delete(key);
    }
  }

  resolvePermission(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): void {
    const key = permissionKey(sessionId, requestId);
    const pending = this.#pending.get(key);

    if (!pending) {
      throw new PermissionRequestNotFoundError(sessionId, requestId);
    }

    clearTimeout(pending.timeout);
    this.#pending.delete(key);
    pending.resolve(approved);
  }
}

interface PendingPermission {
  resolve(approved: boolean): void;
  timeout: ReturnType<typeof setTimeout>;
}

function permissionKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}
