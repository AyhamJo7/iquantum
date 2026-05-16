import { request as nodeRequest } from "node:http";
import type { ServerStreamFrame } from "@iquantum/protocol";
import type { GitCheckpoint, Plan, Session } from "@iquantum/types";

export type { ServerStreamFrame } from "@iquantum/protocol";

export interface DaemonClient {
  health(): Promise<{ ok: boolean }>;
  createSession(
    repoPath: string,
    options?: CreateSessionOptions,
  ): Promise<Session>;
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

export interface CreateSessionOptions {
  requireApproval?: boolean;
  autoApprove?: boolean;
}

export class HttpDaemonClient implements DaemonClient {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  health(): Promise<{ ok: boolean }> {
    return this.#get("/health");
  }

  createSession(
    repoPath: string,
    options: CreateSessionOptions = {},
  ): Promise<Session> {
    return this.#post("/sessions", { repoPath, ...options });
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
    const res = await this.#sseRequest(`/sessions/${sessionId}/stream`);
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of res) {
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.trim();
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data) {
            yield JSON.parse(data) as ServerStreamFrame;
          }
        }
      }
    }
  }

  #sseRequest(path: string): Promise<NodeJS.ReadableStream> {
    const socketPath = this.#socketPath;

    return new Promise((resolve, reject) => {
      const req = nodeRequest({
        socketPath,
        method: "GET",
        path,
        headers: { Accept: "text/event-stream" },
      });

      req.on("response", (res) => {
        if (res.statusCode !== 200) {
          reject(
            new HttpError(`HTTP ${res.statusCode}`, res.statusCode ?? 500),
          );
          return;
        }

        resolve(res);
      });

      req.on("error", reject);
      req.end();
    });
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
