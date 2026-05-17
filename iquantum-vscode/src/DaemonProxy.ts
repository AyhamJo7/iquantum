import type { Session } from "@iquantum/types";
import * as vscode from "vscode";

export interface CreateSessionOptions {
  requireApproval?: boolean;
  autoApprove?: boolean;
  mode?: "piv" | "chat";
}

export class DaemonProxy {
  readonly #baseUrl: string;

  constructor(port: number) {
    this.#baseUrl = `http://127.0.0.1:${port}`;
  }

  static detectPort(): number {
    return vscode.workspace.getConfiguration("iquantum").get("tcpPort", 51820);
  }

  async health(): Promise<{ ok: boolean }> {
    return this.#request("/health");
  }

  async createSession(
    repoPath: string,
    opts: CreateSessionOptions,
  ): Promise<Session> {
    return this.#request("/sessions", {
      method: "POST",
      body: { repoPath, ...opts },
    });
  }

  async getSession(id: string): Promise<Session> {
    return this.#request(`/sessions/${id}`);
  }

  async postMessage(sessionId: string, content: string): Promise<void> {
    await this.#request(`/sessions/${sessionId}/messages`, {
      method: "POST",
      body: { role: "user", content },
    });
  }

  async approvePlan(sessionId: string): Promise<void> {
    await this.#request(`/sessions/${sessionId}/approve`, { method: "POST" });
  }

  async rejectPlan(sessionId: string, feedback: string): Promise<void> {
    await this.#request(`/sessions/${sessionId}/reject`, {
      method: "POST",
      body: { feedback },
    });
  }

  async getPlan(sessionId: string): Promise<{ content: string } | null> {
    try {
      return await this.#request(`/sessions/${sessionId}/plan`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  async postPermission(
    sessionId: string,
    requestId: string,
    approved: boolean,
  ): Promise<void> {
    await this.#request(`/sessions/${sessionId}/permission`, {
      method: "POST",
      body: { requestId, approved },
    });
  }

  openWebSocket(sessionId: string): WebSocket {
    return new WebSocket(
      `${this.#baseUrl.replace(/^http/, "ws")}/sessions/${sessionId}/events`,
    );
  }

  async waitForDaemon(): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if ((await this.health()).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("daemon did not start");
  }

  async #request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers:
        options.body === undefined
          ? undefined
          : { "content-type": "application/json" },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) throw new HttpError(response.status);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
