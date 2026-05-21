import {
  type StructuredOutputCompleter,
  StructuredOutputRouter,
} from "@iquantum/llm";
import type { AgentManifest, WorkerManifest } from "@iquantum/types";
import { z } from "zod";

export interface WorkerResult {
  name: string;
  sessionId: string;
  status: "done" | "failed";
  summary: string;
  diff?: string;
  commitHash?: string;
}

export interface CoordinatorResult {
  workers: WorkerResult[];
}

export interface CoordinatorAgentSpawner {
  spawn(coordinatorSessionId: string, manifest: AgentManifest): Promise<string>;
}

export interface CoordinatorAgentWaiter {
  wait(
    coordinatorSessionId: string,
    workerName: string,
    childSessionId: string,
  ): Promise<WorkerResult>;
}

export interface CoordinatorMerger {
  merge(
    workerResults: readonly WorkerResult[],
    coordinatorSessionId: string,
  ): Promise<void>;
}

export interface CoordinatorEngineOptions {
  architect: StructuredOutputCompleter;
  spawner: CoordinatorAgentSpawner;
  waiter: CoordinatorAgentWaiter;
  merger?: CoordinatorMerger;
  maxAgents?: number;
  maxPlanTokens?: number;
}

const MAX_WORKERS = 20;

const workerManifestSchema = z.object({
  workers: z
    .array(
      z.object({
        name: z.string().min(1).max(128),
        task: z.string().min(1).max(16_384),
        dependsOn: z.array(z.string().min(1).max(128)).optional(),
        worktree: z.boolean(),
      }),
    )
    .min(2)
    .max(MAX_WORKERS)
    .transform((workers) =>
      workers.map((worker) => ({
        name: worker.name,
        task: worker.task,
        ...(worker.dependsOn === undefined
          ? {}
          : { dependsOn: worker.dependsOn }),
        worktree: worker.worktree,
      })),
    ),
});

export class CoordinatorManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorManifestError";
  }
}

export class CoordinatorEngine {
  readonly #structuredRouter: StructuredOutputRouter;
  readonly #spawner: CoordinatorAgentSpawner;
  readonly #waiter: CoordinatorAgentWaiter;
  readonly #merger: CoordinatorMerger | undefined;
  readonly #maxAgents: number;
  readonly #maxPlanTokens: number;

  constructor(options: CoordinatorEngineOptions) {
    this.#structuredRouter = new StructuredOutputRouter(options.architect);
    this.#spawner = options.spawner;
    this.#waiter = options.waiter;
    this.#merger = options.merger;
    this.#maxAgents = options.maxAgents ?? 5;
    this.#maxPlanTokens = options.maxPlanTokens ?? 2000;
  }

  async plan(task: string, repoMap: unknown): Promise<WorkerManifest> {
    const manifest = await this.#structuredRouter.completeStructured(
      [
        {
          role: "system",
          content:
            `Break the user task into 2-${this.#maxAgents} parallel subtasks. ` +
            "Each subtask must be independently achievable in isolation. " +
            "Output only JSON matching { workers: [{ name, task, dependsOn?, worktree }] }.",
        },
        {
          role: "user",
          content: `Task:\n${task}\n\nRepository map:\n${formatRepoMap(repoMap)}`,
        },
      ],
      workerManifestSchema,
      { maxTokens: this.#maxPlanTokens, temperature: 0 },
    );

    validateWorkerManifest(manifest, this.#maxAgents);
    return manifest;
  }

  async execute(
    manifest: WorkerManifest,
    coordinatorSessionId: string,
  ): Promise<CoordinatorResult> {
    validateWorkerManifest(manifest, this.#maxAgents);
    const pending = new Map(
      manifest.workers.map((worker) => [worker.name, worker]),
    );
    const running = new Map<string, Promise<WorkerResult>>();
    const completed = new Set<string>();
    const results: WorkerResult[] = [];

    while (completed.size < manifest.workers.length) {
      let started = 0;
      for (const [name, worker] of pending) {
        const dependencies = worker.dependsOn ?? [];
        if (!dependencies.every((dependency) => completed.has(dependency))) {
          continue;
        }

        pending.delete(name);
        started += 1;
        const childSessionId = await this.#spawner.spawn(coordinatorSessionId, {
          name,
          prompt: worker.task,
          inheritMemory: true,
          worktree: worker.worktree,
        });
        running.set(
          name,
          this.#waiter.wait(coordinatorSessionId, name, childSessionId),
        );
      }

      if (running.size === 0) {
        throw new CoordinatorManifestError(
          started === 0
            ? "Worker manifest has no runnable workers"
            : "Worker execution stalled",
        );
      }

      const { name, result } = await Promise.race(
        [...running.entries()].map(async ([name, promise]) => ({
          name,
          result: await promise,
        })),
      );
      running.delete(name);
      completed.add(name);
      results.push(result);
    }

    await this.merge(results, coordinatorSessionId);
    return { workers: results };
  }

  async merge(
    workerResults: WorkerResult[],
    coordinatorSessionId: string,
  ): Promise<void> {
    await this.#merger?.merge(workerResults, coordinatorSessionId);
  }
}

export function validateWorkerManifest(
  manifest: WorkerManifest,
  maxAgents = Number.POSITIVE_INFINITY,
): void {
  const names = new Set<string>();
  if (manifest.workers.length < 2) {
    throw new CoordinatorManifestError(
      "Worker manifest requires at least 2 workers",
    );
  }

  for (const worker of manifest.workers) {
    if (names.has(worker.name)) {
      throw new CoordinatorManifestError(
        `Duplicate worker name: ${worker.name}`,
      );
    }
    names.add(worker.name);
    if (!worker.worktree) {
      throw new CoordinatorManifestError(
        `Worker ${worker.name} must use a dedicated worktree`,
      );
    }
  }

  if (manifest.workers.length > maxAgents) {
    throw new CoordinatorManifestError(
      `Worker manifest exceeds max agents: ${manifest.workers.length} > ${maxAgents}`,
    );
  }

  for (const worker of manifest.workers) {
    for (const dependency of worker.dependsOn ?? []) {
      if (!names.has(dependency)) {
        throw new CoordinatorManifestError(
          `Worker ${worker.name} depends on unknown worker ${dependency}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byName = new Map(
    manifest.workers.map((worker) => [worker.name, worker]),
  );

  const visit = (name: string): void => {
    if (visited.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      throw new CoordinatorManifestError(
        `Worker manifest contains a circular dependency at ${name}`,
      );
    }

    visiting.add(name);
    const worker = byName.get(name);
    for (const dependency of worker?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
  };

  for (const worker of manifest.workers) {
    visit(worker.name);
  }
}

function formatRepoMap(repoMap: unknown): string {
  return typeof repoMap === "string" ? repoMap : JSON.stringify(repoMap);
}
