import { describe, expect, it, vi } from "vitest";
import {
  CoordinatorEngine,
  CoordinatorManifestError,
  validateWorkerManifest,
  type WorkerResult,
} from "./index";

describe("CoordinatorEngine", () => {
  it("plans a valid worker manifest from structured Architect output", async () => {
    const engine = new CoordinatorEngine({
      architect: completer(
        JSON.stringify({
          workers: [
            { name: "api", task: "build API", worktree: true },
            { name: "tests", task: "write tests", worktree: true },
          ],
        }),
      ),
      spawner: { spawn: vi.fn() },
      waiter: { wait: vi.fn() },
      maxAgents: 3,
    });

    await expect(engine.plan("build service", "repo map")).resolves.toEqual({
      workers: [
        { name: "api", task: "build API", worktree: true },
        { name: "tests", task: "write tests", worktree: true },
      ],
    });
  });

  it("rejects circular dependencies", () => {
    expect(() =>
      validateWorkerManifest({
        workers: [
          { name: "a", task: "A", dependsOn: ["b"], worktree: true },
          { name: "b", task: "B", dependsOn: ["a"], worktree: true },
        ],
      }),
    ).toThrow(CoordinatorManifestError);
  });

  it("rejects manifests without multiple worktree workers", () => {
    expect(() =>
      validateWorkerManifest({
        workers: [{ name: "api", task: "A", worktree: true }],
      }),
    ).toThrow("at least 2 workers");

    expect(() =>
      validateWorkerManifest({
        workers: [
          { name: "api", task: "A", worktree: true },
          { name: "tests", task: "B", worktree: false },
        ],
      }),
    ).toThrow("dedicated worktree");
  });

  it("spawns independent workers before waiting for either to finish", async () => {
    const events: string[] = [];
    const waitResolvers = new Map<string, (result: WorkerResult) => void>();
    const engine = new CoordinatorEngine({
      architect: completer("{}"),
      spawner: {
        async spawn(_coordinatorSessionId, manifest) {
          events.push(`spawn:${manifest.name}`);
          return `session-${manifest.name}`;
        },
      },
      waiter: {
        wait(_coordinatorSessionId, workerName, childSessionId) {
          events.push(`wait:${workerName}`);
          return new Promise<WorkerResult>((resolve) => {
            void childSessionId;
            waitResolvers.set(workerName, resolve);
          });
        },
      },
      merger: {
        async merge() {
          events.push("merge");
        },
      },
    });

    const execution = engine.execute(
      {
        workers: [
          { name: "api", task: "build API", worktree: true },
          { name: "tests", task: "write tests", worktree: true },
        ],
      },
      "coordinator-1",
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([
      "spawn:api",
      "wait:api",
      "spawn:tests",
      "wait:tests",
    ]);

    waitResolvers.get("tests")?.({
      name: "tests",
      sessionId: "session-tests",
      status: "done",
      summary: "tests complete",
    });
    await Promise.resolve();
    waitResolvers.get("api")?.({
      name: "api",
      sessionId: "session-api",
      status: "done",
      summary: "api complete",
    });

    await expect(execution).resolves.toEqual({
      workers: [
        {
          name: "tests",
          sessionId: "session-tests",
          status: "done",
          summary: "tests complete",
        },
        {
          name: "api",
          sessionId: "session-api",
          status: "done",
          summary: "api complete",
        },
      ],
    });
    expect(events.at(-1)).toBe("merge");
  });

  it("waits for dependencies before spawning dependent workers", async () => {
    const events: string[] = [];
    const engine = new CoordinatorEngine({
      architect: completer("{}"),
      spawner: {
        async spawn(_coordinatorSessionId, manifest) {
          events.push(`spawn:${manifest.name}`);
          return `session-${manifest.name}`;
        },
      },
      waiter: {
        async wait(_coordinatorSessionId, workerName, childSessionId) {
          events.push(`done:${workerName}`);
          return {
            name: workerName,
            sessionId: childSessionId,
            status: "done",
            summary: `${workerName} complete`,
          };
        },
      },
    });

    await engine.execute(
      {
        workers: [
          { name: "api", task: "build API", worktree: true },
          {
            name: "tests",
            task: "write tests",
            dependsOn: ["api"],
            worktree: true,
          },
        ],
      },
      "coordinator-1",
    );

    expect(events).toEqual([
      "spawn:api",
      "done:api",
      "spawn:tests",
      "done:tests",
    ]);
  });
});

it("completes with failed results when all workers fail", async () => {
  const engine = new CoordinatorEngine({
    architect: completer("{}"),
    spawner: {
      async spawn(_coordinatorSessionId, manifest) {
        return `session-${manifest.name}`;
      },
    },
    waiter: {
      async wait(_coordinatorSessionId, workerName, childSessionId) {
        return {
          name: workerName,
          sessionId: childSessionId,
          status: "failed",
          summary: "failed",
        };
      },
    },
    merger: { async merge() {} },
  });

  const result = await engine.execute(
    {
      workers: [
        { name: "api", task: "build API", worktree: true },
        { name: "tests", task: "write tests", worktree: true },
      ],
    },
    "coordinator-1",
  );

  expect(result.workers.every((w) => w.status === "failed")).toBe(true);
});

it("throws CoordinatorManifestError when execute receives a single-worker manifest", async () => {
  const engine = new CoordinatorEngine({
    architect: completer("{}"),
    spawner: { spawn: vi.fn() },
    waiter: { wait: vi.fn() },
  });

  await expect(
    engine.execute(
      {
        workers: [{ name: "a", task: "A", worktree: true }] as unknown as [
          { name: string; task: string; worktree: boolean },
          { name: string; task: string; worktree: boolean },
        ],
      },
      "coordinator-1",
    ),
  ).rejects.toThrow(CoordinatorManifestError);
});

function completer(output: string) {
  return {
    async *complete() {
      yield output;
    },
  };
}
