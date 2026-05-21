import type { EventEmitter } from "node:events";
import type { AgentManifest, Session } from "@iquantum/types";
import type { AgentColorManager } from "./color-manager";
import type { AgentRegistry } from "./registry";

type ProtocolPhase = "planning" | "implementing" | "validating";

export interface AgentSpawnerSessionController {
  createSession(
    repoPath: string,
    options: {
      worktree?: boolean;
      parentSessionId?: string;
      agentName?: string;
      agentColor?: string;
      inheritedMemory?: string;
      allowedTools?: string[];
      autoApprove?: boolean;
      requireApproval?: boolean;
    },
  ): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  startTask(sessionId: string, prompt: string): Promise<{ id: string }>;
  approve(sessionId: string, planId?: string): Promise<void>;
  listCheckpoints?(
    sessionId: string,
    options?: { limit: number },
  ): Promise<{ checkpoints: Array<{ commitHash: string }> }>;
  destroySession(sessionId: string): Promise<void>;
  getEngine?(sessionId: string): {
    readonly events: EventEmitter;
  };
}

export interface AgentSpawnerRepoMapCache {
  get(sessionId: string): unknown;
  set(sessionId: string, repoMap: unknown): void;
}

export interface AgentSpawnerMemoryManager {
  serializeForSession?(sessionId: string): Promise<string>;
}

export interface AgentSpawnerStreams {
  publish(
    sessionId: string,
    frame:
      | {
          type: "agent_spawned";
          sessionId: string;
          name: string;
          colorIndex: number;
          coordinatorSessionId: string;
        }
      | {
          type: "agent_killed";
          sessionId: string;
          name: string;
          reason: string;
        }
      | {
          type: "agent_failed";
          sessionId: string;
          name: string;
          error: string;
        }
      | {
          type: "agent_status";
          sessionId: string;
          name: string;
          status: "running" | "done" | "failed" | "killed";
          phase?: ProtocolPhase;
          turnIndex?: number;
          maxTurns?: number;
        }
      | {
          type: "agent_done";
          sessionId: string;
          name: string;
          summary: string;
        },
  ): void;
}

export interface AgentSpawnerOptions {
  sessionController: AgentSpawnerSessionController;
  repoMapCache?: AgentSpawnerRepoMapCache;
  memoryManager?: AgentSpawnerMemoryManager;
  agentRegistry: AgentRegistry;
  colorManager: AgentColorManager;
  streams?: AgentSpawnerStreams;
  maxAgents?: number;
  defaultMaxTurns?: number;
}

export class AgentLimitError extends Error {
  constructor(readonly maxAgents: number) {
    super(`Coordinator has reached the maximum of ${maxAgents} agents`);
    this.name = "AgentLimitError";
  }
}

export class AgentSpawner {
  readonly #sessionController: AgentSpawnerSessionController;
  readonly #repoMapCache: AgentSpawnerRepoMapCache | undefined;
  readonly #memoryManager: AgentSpawnerMemoryManager | undefined;
  readonly #agentRegistry: AgentRegistry;
  readonly #colorManager: AgentColorManager;
  readonly #streams: AgentSpawnerStreams | undefined;
  readonly #maxAgents: number;
  readonly #defaultMaxTurns: number | undefined;
  #pendingByCoordinator = new Map<string, number>();

  constructor(options: AgentSpawnerOptions) {
    this.#sessionController = options.sessionController;
    this.#repoMapCache = options.repoMapCache;
    this.#memoryManager = options.memoryManager;
    this.#agentRegistry = options.agentRegistry;
    this.#colorManager = options.colorManager;
    this.#streams = options.streams;
    this.#maxAgents = options.maxAgents ?? 5;
    this.#defaultMaxTurns = options.defaultMaxTurns;
  }

  async spawn(
    coordinatorSessionId: string,
    manifest: AgentManifest,
  ): Promise<string> {
    const active = this.#agentRegistry.list(coordinatorSessionId).length;
    const pending = this.#pendingByCoordinator.get(coordinatorSessionId) ?? 0;
    if (active + pending >= this.#maxAgents) {
      throw new AgentLimitError(this.#maxAgents);
    }
    this.#pendingByCoordinator.set(coordinatorSessionId, pending + 1);

    const effectiveMaxTurns = manifest.maxTurns ?? this.#defaultMaxTurns;
    let registered = false;

    try {
      const coordinator =
        await this.#sessionController.getSession(coordinatorSessionId);
      const color = this.#colorManager.next();
      const inheritedMemory = manifest.inheritMemory
        ? await this.#memoryManager?.serializeForSession?.(coordinatorSessionId)
        : undefined;
      const childSession = await this.#sessionController.createSession(
        coordinator.repoPath,
        {
          worktree: manifest.worktree,
          parentSessionId: coordinatorSessionId,
          agentName: manifest.name,
          agentColor: String(color.index),
          ...(inheritedMemory ? { inheritedMemory } : {}),
          ...(manifest.tools?.length ? { allowedTools: manifest.tools } : {}),
          autoApprove: true,
          requireApproval: false,
        },
      );

      this.#cloneRepoMap(coordinatorSessionId, childSession.id);
      this.#agentRegistry.register(
        childSession.id,
        manifest.name,
        color.index,
        coordinatorSessionId,
      );
      registered = true;
      this.#decrementPending(coordinatorSessionId);

      this.#streams?.publish(coordinatorSessionId, {
        type: "agent_spawned",
        sessionId: childSession.id,
        name: manifest.name,
        colorIndex: color.index,
        coordinatorSessionId,
      });
      this.#streams?.publish(coordinatorSessionId, {
        type: "agent_status",
        sessionId: childSession.id,
        name: manifest.name,
        status: "running",
        ...(effectiveMaxTurns === undefined
          ? {}
          : { maxTurns: effectiveMaxTurns }),
      });
      const unsubscribeStatus = this.#forwardChildStatus(
        coordinatorSessionId,
        childSession.id,
        manifest,
        effectiveMaxTurns,
      );

      void this.#sessionController
        .startTask(childSession.id, manifest.prompt)
        .then((plan) =>
          this.#sessionController.approve(childSession.id, plan.id),
        )
        .then(async () => {
          unsubscribeStatus();
          const checkpoint = (
            await this.#sessionController
              .listCheckpoints?.(childSession.id, { limit: 1 })
              .catch(() => ({ checkpoints: [] }))
          )?.checkpoints.at(0);
          this.#agentRegistry.updateStatus(childSession.id, "done");
          this.#streams?.publish(coordinatorSessionId, {
            type: "agent_status",
            sessionId: childSession.id,
            name: manifest.name,
            status: "done",
            ...(effectiveMaxTurns === undefined
              ? {}
              : { maxTurns: effectiveMaxTurns }),
          });
          this.#streams?.publish(coordinatorSessionId, {
            type: "agent_done",
            sessionId: childSession.id,
            name: manifest.name,
            summary: checkpoint?.commitHash ?? "completed",
          });
        })
        .catch((error: unknown) => {
          unsubscribeStatus();
          // Don't overwrite "killed" status set by kill()
          if (this.#agentRegistry.get(childSession.id)?.status !== "killed") {
            this.#agentRegistry.updateStatus(childSession.id, "failed");
            this.#streams?.publish(coordinatorSessionId, {
              type: "agent_status",
              sessionId: childSession.id,
              name: manifest.name,
              status: "failed",
              ...(effectiveMaxTurns === undefined
                ? {}
                : { maxTurns: effectiveMaxTurns }),
            });
            this.#streams?.publish(coordinatorSessionId, {
              type: "agent_failed",
              sessionId: childSession.id,
              name: manifest.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });

      return childSession.id;
    } catch (err) {
      if (!registered) {
        this.#decrementPending(coordinatorSessionId);
      }
      throw err;
    }
  }

  async kill(childSessionId: string, reason: string): Promise<void> {
    const entry = this.#agentRegistry.get(childSessionId);
    await this.#sessionController
      .destroySession(childSessionId)
      .catch((err: unknown) => {
        if (!(err instanceof Error) || err.name !== "SessionNotFoundError") {
          throw err;
        }
      });
    if (!entry) {
      return;
    }

    this.#agentRegistry.updateStatus(childSessionId, "killed");
    this.#streams?.publish(entry.coordinatorSessionId, {
      type: "agent_killed",
      sessionId: childSessionId,
      name: entry.name,
      reason,
    });
  }

  #decrementPending(coordinatorSessionId: string): void {
    const n = (this.#pendingByCoordinator.get(coordinatorSessionId) ?? 0) - 1;
    if (n <= 0) {
      this.#pendingByCoordinator.delete(coordinatorSessionId);
    } else {
      this.#pendingByCoordinator.set(coordinatorSessionId, n);
    }
  }

  #cloneRepoMap(coordinatorSessionId: string, childSessionId: string): void {
    const repoMap = this.#repoMapCache?.get(coordinatorSessionId);
    if (repoMap === undefined) {
      return;
    }

    this.#repoMapCache?.set(childSessionId, structuredClone(repoMap));
  }

  #forwardChildStatus(
    coordinatorSessionId: string,
    childSessionId: string,
    manifest: AgentManifest,
    effectiveMaxTurns: number | undefined,
  ): () => void {
    const events = this.#sessionController.getEngine?.(childSessionId).events;
    if (!events) {
      return () => undefined;
    }

    const onPhaseChange = (event: { to?: string }) => {
      const phase = toProtocolPhase(event.to);
      if (!phase) {
        return;
      }

      this.#streams?.publish(coordinatorSessionId, {
        type: "agent_status",
        sessionId: childSessionId,
        name: manifest.name,
        status: "running",
        phase,
        ...(effectiveMaxTurns === undefined
          ? {}
          : { maxTurns: effectiveMaxTurns }),
      });
    };

    events.on("phase_change", onPhaseChange);
    return () => events.off("phase_change", onPhaseChange);
  }
}

function toProtocolPhase(
  status: string | undefined,
): ProtocolPhase | undefined {
  switch (status) {
    case "planning":
    case "implementing":
    case "validating":
      return status;
    default:
      return undefined;
  }
}
