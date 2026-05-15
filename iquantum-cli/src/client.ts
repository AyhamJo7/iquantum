import { request as nodeRequest } from "node:http";
import type { GitCheckpoint, Plan, Session } from "@iquantum/types";

export type ServerStreamFrame =
  | { type: "token"; delta: string }
  | { type: "phase_change"; phase: string }
  | { type: "plan_ready"; planId: string }
  | { type: "validate_result"; passed: boolean; attempt: number }
  | { type: "checkpoint"; hash: string }
  | { type: "error"; message: string };

export interface DaemonClient {
  health(): Promise<{ ok: boolean }>;
  createSession(repoPath: string): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  destroySession(sessionId: string): Promise<void>;
  startTask(sessionId: string, prompt: string): Promise<Plan>;
  currentPlan(sessionId: string): Promise<Plan | null>;
  approve(sessionId: string): Promise<void>;
  reject(sessionId: string, feedback: string): Promise<Plan>;
  listCheckpoints(sessionId: string): Promise<GitCheckpoint[]>;
  restore(sessionId: string, hash: string): Promise<void>;
  openStream(sessionId: string): AsyncIterable<ServerStreamFrame>;
}

export class HttpDaemonClient implements DaemonClient {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  health(): Promise<{ ok: boolean }> {
    return this.#get("/health");
  }

  createSession(repoPath: string): Promise<Session> {
    return this.#post("/sessions", { repoPath });
  }

  getSession(sessionId: string): Promise<Session> {
    return this.#get(`/sessions/${sessionId}`);
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.#delete(`/sessions/${sessionId}`);
  }

  startTask(sessionId: string, prompt: string): Promise<Plan> {
    return this.#post(`/sessions/${sessionId}/task`, { prompt });
  }

  async currentPlan(sessionId: string): Promise<Plan | null> {
    try {
      return await this.#get<Plan>(`/sessions/${sessionId}/plan`);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) {
        return null;
      }

      throw error;
    }
  }

  async approve(sessionId: string): Promise<void> {
    await this.#post(`/sessions/${sessionId}/approve`);
  }

  reject(sessionId: string, feedback: string): Promise<Plan> {
    return this.#post(`/sessions/${sessionId}/reject`, { feedback });
  }

  listCheckpoints(sessionId: string): Promise<GitCheckpoint[]> {
    return this.#get(`/sessions/${sessionId}/checkpoints`);
  }

  async restore(sessionId: string, hash: string): Promise<void> {
    await this.#post(
      `/sessions/${sessionId}/checkpoints/${encodeURIComponent(hash)}/restore`,
    );
  }

  async *openStream(sessionId: string): AsyncGenerator<ServerStreamFrame> {
    const socketPath = this.#socketPath;
    const queue: Array<ServerStreamFrame | Error | null> = [];
    let wakeResolve: (() => void) | null = null;

    const wake = (): void => {
      wakeResolve?.();
      wakeResolve = null;
    };

    // Bun overrides the ws WebSocket class and ignores socketPath.
    // Use node:http (which respects socketPath) to perform the WebSocket
    // upgrade manually, then parse frames with ws.Receiver.
    const wsKey = Buffer.from(
      crypto.getRandomValues(new Uint8Array(16)),
    ).toString("base64");

    const req = nodeRequest({
      socketPath,
      method: "GET",
      path: `/sessions/${sessionId}/stream`,
      headers: {
        Host: "localhost",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": wsKey,
        "Sec-WebSocket-Version": "13",
      },
    });

    req.on("upgrade", (_res, socket, head) => {
      let buf = head.length > 0 ? head : Buffer.alloc(0);

      const flush = (): void => {
        // Parse all complete WebSocket frames (server→client are never masked).
        while (buf.length >= 2) {
          const b0 = buf[0] ?? 0;
          const b1 = buf[1] ?? 0;
          const opcode = b0 & 0x0f;
          let payloadLen = b1 & 0x7f;
          let headerEnd = 2;

          if (payloadLen === 126) {
            if (buf.length < 4) break;
            payloadLen = buf.readUInt16BE(2);
            headerEnd = 4;
          } else if (payloadLen === 127) {
            if (buf.length < 10) break;
            payloadLen = buf.readUInt32BE(6); // lower 32 bits sufficient
            headerEnd = 10;
          }

          if (buf.length < headerEnd + payloadLen) break;

          const payload = buf.slice(headerEnd, headerEnd + payloadLen);
          buf = buf.slice(headerEnd + payloadLen);

          if (opcode === 0x8) {
            // close frame
            queue.push(null);
            wake();
            return;
          }

          if (opcode === 0x1 || opcode === 0x2) {
            // text or binary
            try {
              queue.push(
                JSON.parse(payload.toString("utf8")) as ServerStreamFrame,
              );
            } catch {
              queue.push(new Error("malformed stream frame"));
            }
            wake();
          }
        }
      };

      flush();

      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        flush();
      });
      socket.on("close", () => {
        queue.push(null);
        wake();
      });
      socket.on("error", (err: Error) => {
        queue.push(err);
        wake();
      });
    });

    req.on("error", (err) => {
      queue.push(err instanceof Error ? err : new Error(String(err)));
      wake();
    });

    req.end();

    try {
      while (true) {
        while (queue.length > 0) {
          const item = queue.shift() as ServerStreamFrame | Error | null;

          if (item === null) {
            return;
          }

          if (item instanceof Error) {
            throw item;
          }

          yield item;
        }

        await new Promise<void>((resolve) => {
          wakeResolve = resolve;
        });
      }
    } finally {
      req.destroy();
    }
  }

  #get<T = unknown>(path: string): Promise<T> {
    return this.#request("GET", path);
  }

  #post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.#request("POST", path, body);
  }

  #delete<T = unknown>(path: string): Promise<T> {
    return this.#request("DELETE", path);
  }

  #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

      const req = nodeRequest(
        {
          socketPath: this.#socketPath,
          method,
          path,
          headers: bodyStr
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(bodyStr),
              }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8").trim();

            if (res.statusCode && res.statusCode >= 400) {
              let message = `HTTP ${res.statusCode}`;

              try {
                const parsed = JSON.parse(text) as { error?: string };
                if (parsed.error) {
                  message = parsed.error;
                }
              } catch {}

              reject(new HttpError(message, res.statusCode));
              return;
            }

            resolve((text ? (JSON.parse(text) as T) : undefined) as T);
          });
        },
      );

      req.on("error", reject);

      if (bodyStr) {
        req.write(bodyStr);
      }

      req.end();
    });
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isDaemonNotRunning(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes("ENOENT") || error.message.includes("ECONNREFUSED")
    );
  }

  return false;
}
