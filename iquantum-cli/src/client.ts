import { request as nodeRequest } from "node:http";
import type { GitCheckpoint, Plan, Session } from "@iquantum/types";
import WebSocket from "ws";

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
    const ws = new WebSocket(`ws://localhost/sessions/${sessionId}/stream`, {
      socketPath,
    });

    const queue: Array<ServerStreamFrame | Error | null> = [];
    let wakeResolve: (() => void) | null = null;

    const wake = (): void => {
      wakeResolve?.();
      wakeResolve = null;
    };

    ws.on("message", (data) => {
      try {
        queue.push(JSON.parse(data.toString()) as ServerStreamFrame);
      } catch {
        queue.push(new Error("malformed stream frame"));
      }

      wake();
    });

    ws.on("close", () => {
      queue.push(null);
      wake();
    });

    ws.on("error", (err) => {
      queue.push(err instanceof Error ? err : new Error(String(err)));
      wake();
    });

    try {
      while (true) {
        while (queue.length > 0) {
          // queue.length > 0 guarantees shift() returns a value
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
      if (ws.readyState < 2) {
        ws.close();
      }
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
