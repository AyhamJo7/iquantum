import type { AgentRegistry } from "@iquantum/agent";
import type { WorkerResult } from "@iquantum/coordinator";

const AGENT_POLL_INTERVAL_MS = 250;

export interface AgentWaiterSessions {
  listCheckpoints(
    sessionId: string,
    options: { limit: number },
  ): Promise<{ checkpoints: Array<{ commitHash: string }> }>;
}

export class AgentWaiter {
  readonly #registry: AgentRegistry;
  readonly #sessions: AgentWaiterSessions;
  readonly #timeoutMs: number;

  constructor(
    registry: AgentRegistry,
    sessions: AgentWaiterSessions,
    timeoutMs: number,
  ) {
    this.#registry = registry;
    this.#sessions = sessions;
    this.#timeoutMs = timeoutMs;
  }

  async wait(
    _coordinatorSessionId: string,
    workerName: string,
    childSessionId: string,
  ): Promise<WorkerResult> {
    const deadline = Date.now() + this.#timeoutMs;

    while (Date.now() < deadline) {
      const entry = this.#registry.get(childSessionId);

      if (entry === undefined) {
        return {
          name: workerName,
          sessionId: childSessionId,
          status: "failed",
          summary: "deregistered",
        };
      }

      if (
        entry.status === "done" ||
        entry.status === "failed" ||
        entry.status === "killed"
      ) {
        const checkpoints = await this.#sessions.listCheckpoints(
          childSessionId,
          { limit: 1 },
        );
        const checkpoint = checkpoints.checkpoints.at(0);
        return {
          name: workerName,
          sessionId: childSessionId,
          status: entry.status === "done" ? "done" : "failed",
          summary:
            entry.status === "done"
              ? "completed"
              : entry.status === "killed"
                ? "killed"
                : "failed",
          ...(checkpoint ? { commitHash: checkpoint.commitHash } : {}),
        };
      }

      await new Promise<void>((resolve) =>
        setTimeout(resolve, AGENT_POLL_INTERVAL_MS),
      );
    }

    return {
      name: workerName,
      sessionId: childSessionId,
      status: "failed",
      summary: `timed out after ${this.#timeoutMs}ms`,
    };
  }
}
