import type { AgentEntry, Session } from "@iquantum/types";

export class DuplicateAgentError extends Error {
  constructor(readonly sessionId: string) {
    super(`Agent session ${sessionId} is already registered`);
    this.name = "DuplicateAgentError";
  }
}

export class AgentRegistry {
  readonly #entries = new Map<string, AgentEntry>();

  register(
    sessionId: string,
    name: string,
    colorIndex: number,
    coordinatorSessionId: string,
  ): void {
    if (this.#entries.has(sessionId)) {
      throw new DuplicateAgentError(sessionId);
    }

    this.#entries.set(sessionId, {
      sessionId,
      name,
      colorIndex,
      coordinatorSessionId,
      status: "running",
    });
  }

  get(sessionId: string): AgentEntry | undefined {
    return this.#entries.get(sessionId);
  }

  list(coordinatorSessionId: string): AgentEntry[] {
    return [...this.#entries.values()].filter(
      (entry) => entry.coordinatorSessionId === coordinatorSessionId,
    );
  }

  deregister(sessionId: string): void {
    this.#entries.delete(sessionId);
  }

  updateStatus(sessionId: string, status: AgentEntry["status"]): AgentEntry {
    const entry = this.#entries.get(sessionId);
    if (!entry) {
      throw new AgentNotFoundError(sessionId);
    }

    const updated = { ...entry, status };
    this.#entries.set(sessionId, updated);
    return updated;
  }

  rebuildFromDb(sessions: readonly Session[]): void {
    this.#entries.clear();
    for (const session of sessions) {
      if (!session.parentSessionId || !session.agentName) {
        continue;
      }

      this.#entries.set(session.id, {
        sessionId: session.id,
        name: session.agentName,
        colorIndex: parseColorIndex(session.agentColor),
        coordinatorSessionId: session.parentSessionId,
        status:
          session.status === "completed"
            ? "done"
            : session.status === "error"
              ? "failed"
              : "running",
      });
    }
  }
}

export class AgentNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown agent session ${sessionId}`);
    this.name = "AgentNotFoundError";
  }
}

function parseColorIndex(agentColor: string | null | undefined): number {
  if (!agentColor) {
    return 0;
  }

  const parsed = Number.parseInt(agentColor, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
