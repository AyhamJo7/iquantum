import { request as nodeRequest } from "node:http";
import type { ServerStreamFrame } from "@iquantum/protocol";
import type {
  ContextStats,
  EffortLevel,
  GitCheckpoint,
  Memory,
  Plan,
  Session,
} from "@iquantum/types";

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
  postMessage(sessionId: string, content: string): Promise<void>;
  postPermission(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<void>;
  deleteMessages(sessionId: string): Promise<void>;
  compact(
    sessionId: string,
  ): Promise<{ compacted: boolean; summary: string | null }>;
  getMessages(
    sessionId: string,
    options?: { before?: string; limit?: number },
  ): Promise<ConversationPage>;
  cancelStream(sessionId: string): Promise<void>;
  listMcpTools(): Promise<McpToolEntry[]>;
  listMemories(options?: {
    type?: Memory["type"];
    pinned?: boolean;
  }): Promise<Memory[]>;
  createMemory(
    memory: Pick<Memory, "type" | "name" | "description" | "body" | "pinned">,
  ): Promise<Memory>;
  updateMemory(
    id: string,
    updates: Partial<
      Pick<Memory, "type" | "name" | "description" | "body" | "pinned">
    >,
  ): Promise<Memory>;
  deleteMemory(id: string): Promise<void>;
  syncMemoryFromFile(): Promise<{ upserted: number }>;
  openStream(sessionId: string): AsyncIterable<ServerStreamFrame>;
  patchSessionConfig(
    sessionId: string,
    config: { effort?: EffortLevel },
  ): Promise<Session>;
  getDiff(
    sessionId: string,
    options?: { from?: string; to?: string },
  ): Promise<string>;
  getContextStats(sessionId: string): Promise<ContextStats>;
  exportSession(
    sessionId: string,
    options?: { format?: "markdown" | "json" },
  ): Promise<string>;
  listHooks?(): Promise<HookEntry[]>;
  reviewSession?(
    sessionId: string,
    target: ReviewTarget,
  ): AsyncIterable<ReviewStreamEvent>;
}

export type { ContextStats };

export interface McpToolEntry {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface HookEntry {
  name: string;
  events: string[];
  filePath: string;
}

export type ReviewSeverity = "critical" | "high" | "medium" | "low";

export interface ReviewFinding {
  severity: ReviewSeverity;
  title: string;
  file: string;
  line: number | null;
  description: string;
  suggestion: string;
}

export type ReviewTarget =
  | { type: "staged" }
  | { type: "commit"; ref: string }
  | { type: "path"; path: string }
  | { type: "pr"; ref: string };

export type ReviewStreamEvent =
  | ReviewFinding
  | { type: "done"; summary: string; durationMs: number };

export interface ConversationEntry {
  id: string;
  role: string;
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface ConversationPage {
  messages: ConversationEntry[];
  nextCursor: string | null;
}

export interface CreateSessionOptions {
  requireApproval?: boolean;
  autoApprove?: boolean;
  mode?: "piv" | "chat";
  extraRepoPaths?: string[];
  effort?: EffortLevel;
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

  async listCheckpoints(sessionId: string): Promise<GitCheckpoint[]> {
    const response = await this.#get<
      GitCheckpoint[] | { checkpoints: GitCheckpoint[] }
    >(`/sessions/${sessionId}/checkpoints`);
    return Array.isArray(response) ? response : response.checkpoints;
  }

  async restore(sessionId: string, hash: string): Promise<void> {
    await this.#post(
      `/sessions/${sessionId}/checkpoints/${encodeURIComponent(hash)}/restore`,
    );
  }

  async postMessage(sessionId: string, content: string): Promise<void> {
    await this.#post(`/sessions/${sessionId}/messages`, {
      role: "user",
      content,
    });
  }

  async postPermission(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<void> {
    await this.#post(`/sessions/${sessionId}/permission`, {
      requestId,
      approved,
    });
  }

  async deleteMessages(sessionId: string): Promise<void> {
    await this.#delete(`/sessions/${sessionId}/messages`);
  }

  compact(
    sessionId: string,
  ): Promise<{ compacted: boolean; summary: string | null }> {
    return this.#post(`/sessions/${sessionId}/compact`);
  }

  getMessages(
    sessionId: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<ConversationPage> {
    const params = new URLSearchParams();
    if (options.before) params.set("before", options.before);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const qs = params.toString();
    return this.#get(`/sessions/${sessionId}/messages${qs ? `?${qs}` : ""}`);
  }

  async cancelStream(sessionId: string): Promise<void> {
    await this.#post(`/sessions/${sessionId}/cancel`);
  }

  listMcpTools(): Promise<McpToolEntry[]> {
    return this.#get("/mcp/tools");
  }

  listMemories(
    options: { type?: Memory["type"]; pinned?: boolean } = {},
  ): Promise<Memory[]> {
    const params = new URLSearchParams();
    if (options.type) params.set("type", options.type);
    if (options.pinned !== undefined) {
      params.set("pinned", String(options.pinned));
    }
    const qs = params.toString();
    return this.#get(`/memory${qs ? `?${qs}` : ""}`);
  }

  createMemory(
    memory: Pick<Memory, "type" | "name" | "description" | "body" | "pinned">,
  ): Promise<Memory> {
    return this.#post("/memory", memory);
  }

  updateMemory(
    id: string,
    updates: Partial<
      Pick<Memory, "type" | "name" | "description" | "body" | "pinned">
    >,
  ): Promise<Memory> {
    return this.#patch(`/memory/${encodeURIComponent(id)}`, updates);
  }

  async deleteMemory(id: string): Promise<void> {
    await this.#delete(`/memory/${encodeURIComponent(id)}`);
  }

  syncMemoryFromFile(): Promise<{ upserted: number }> {
    return this.#post("/memory/sync-from-file");
  }

  patchSessionConfig(
    sessionId: string,
    config: { effort?: EffortLevel },
  ): Promise<Session> {
    return this.#patch(`/sessions/${sessionId}/config`, config);
  }

  async getDiff(
    sessionId: string,
    options: { from?: string; to?: string } = {},
  ): Promise<string> {
    const params = new URLSearchParams();
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    const qs = params.toString();
    return this.#getText(`/sessions/${sessionId}/diff${qs ? `?${qs}` : ""}`);
  }

  getContextStats(sessionId: string): Promise<ContextStats> {
    return this.#get(`/sessions/${sessionId}/context-stats`);
  }

  async exportSession(
    sessionId: string,
    options: { format?: "markdown" | "json" } = {},
  ): Promise<string> {
    const params = new URLSearchParams();
    if (options.format) params.set("format", options.format);
    const qs = params.toString();
    return this.#getText(`/sessions/${sessionId}/export${qs ? `?${qs}` : ""}`);
  }

  listHooks(): Promise<HookEntry[]> {
    return this.#get("/hooks");
  }

  async *openStream(sessionId: string): AsyncGenerator<ServerStreamFrame> {
    const res = await this.#sseRequest("GET", `/sessions/${sessionId}/stream`);
    yield* this.#parseSse<ServerStreamFrame>(res);
  }

  async *reviewSession(
    sessionId: string,
    target: ReviewTarget,
  ): AsyncGenerator<ReviewStreamEvent> {
    const res = await this.#sseRequest(
      "POST",
      `/sessions/${sessionId}/review`,
      { target },
      0,
    );
    yield* this.#parseSse<ReviewStreamEvent>(res);
  }

  #sseRequest(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idleTimeoutMs = 30_000,
  ): Promise<NodeJS.ReadableStream> {
    const socketPath = this.#socketPath;

    return new Promise((resolve, reject) => {
      const bodyStr = body === undefined ? undefined : JSON.stringify(body);
      const req = nodeRequest({
        socketPath,
        method,
        path,
        headers: {
          Accept: "text/event-stream",
          ...(bodyStr
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(bodyStr),
              }
            : {}),
        },
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
      if (idleTimeoutMs > 0) {
        req.setTimeout(idleTimeoutMs, () => {
          req.destroy(new Error("daemon request timed out"));
        });
      }
      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  async *#parseSse<T>(res: NodeJS.ReadableStream): AsyncGenerator<T> {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of res) {
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const event = parseSsePart<T>(part);
        if (event !== undefined) {
          yield event;
        }
      }
    }
  }

  #get<T = unknown>(path: string): Promise<T> {
    return this.#request("GET", path);
  }

  #getText(path: string): Promise<string> {
    return this.#requestText("GET", path);
  }

  #post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.#request("POST", path, body);
  }

  #patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.#request("PATCH", path, body);
  }

  #delete<T = unknown>(path: string): Promise<T> {
    return this.#request("DELETE", path);
  }

  #requestText(method: string, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = nodeRequest(
        {
          socketPath: this.#socketPath,
          method,
          path,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode && res.statusCode >= 400) {
              let message = `HTTP ${res.statusCode}`;
              try {
                const parsed = JSON.parse(text) as { error?: string };
                if (parsed.error) message = parsed.error;
              } catch {}
              reject(new HttpError(message, res.statusCode));
              return;
            }
            resolve(text);
          });
        },
      );
      req.setTimeout(30_000, () => {
        req.destroy(new Error("daemon request timed out"));
      });
      req.on("error", reject);
      req.end();
    });
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

      req.setTimeout(10_000, () => {
        req.destroy(new Error("daemon request timed out"));
      });
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

function parseSsePart<T>(part: string): T | undefined {
  const lines = part.trim().split("\n");
  if (lines.every((line) => line.startsWith(":"))) {
    return undefined;
  }

  const eventName =
    lines
      .find((line) => line.startsWith("event: "))
      ?.slice(7)
      .trim() ?? "message";
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n")
    .trim();

  if (!data) {
    return undefined;
  }

  if (eventName === "error") {
    let message = data;
    try {
      const parsed = JSON.parse(data) as { message?: string };
      message = parsed.message ?? data;
    } catch {}
    throw new Error(message);
  }

  return JSON.parse(data) as T;
}

export function isDaemonNotRunning(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;

    return (
      error.message.includes("ENOENT") ||
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("typo in the url or port") ||
      code === "FailedToOpenSocket"
    );
  }

  return false;
}
