import { DiffApplyError } from "@iquantum/diff-engine";
import type { ExecResult } from "@iquantum/sandbox";
import type { GitCheckpoint, LLMMessage } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import {
  InMemoryPIVStore,
  type PhaseChangeEvent,
  PIVEngine,
  RetryLimitExceededError,
} from "./index";

const fixedNow = "2026-05-15T00:00:00.000Z";

describe("PIVEngine", () => {
  it("replans after rejection and includes approval feedback", async () => {
    const harness = createHarness({ completions: ["plan one", "plan two"] });

    const firstPlan = await harness.engine.startTask("add auth");
    const secondPlan = await harness.engine.reject(
      firstPlan.id,
      "Please split the work into smaller steps.",
    );

    expect(secondPlan.content).toBe("plan two");
    expect(harness.store.plans.map((plan) => plan.status)).toEqual([
      "rejected",
      "pending",
    ]);
    expect(harness.completionCalls[1]?.messages[1]?.content).toContain(
      "Please split the work into smaller steps.",
    );
    expect(harness.transitions).toEqual([
      ["idle", "planning"],
      ["planning", "awaiting_approval"],
      ["awaiting_approval", "planning"],
      ["planning", "awaiting_approval"],
    ]);
  });

  it("retries implementation after a structured diff failure", async () => {
    const harness = createHarness({
      completions: ["plan", "bad diff", "good diff"],
      diffFailures: [
        new DiffApplyError([
          { filePath: "src/a.ts", hunkIndex: 0, reason: "no match" },
        ]),
      ],
    });

    const plan = await harness.engine.startTask("edit code");
    await harness.engine.approve(plan.id);

    expect(harness.diffCalls).toEqual(["bad diff", "good diff"]);
    expect(
      harness.store.messages.some(
        (message) =>
          message.role === "tool_result" &&
          message.content.includes("no match"),
      ),
    ).toBe(true);
    expect(harness.engine.status).toBe("completed");
  });

  it("enters error after the retry budget is exhausted", async () => {
    const harness = createHarness({
      completions: ["plan", "bad one", "bad two"],
      diffFailures: [
        new DiffApplyError([
          { filePath: "src/a.ts", hunkIndex: 0, reason: "no match" },
        ]),
        new DiffApplyError([
          { filePath: "src/a.ts", hunkIndex: 1, reason: "still no match" },
        ]),
      ],
      maxRetries: 1,
    });
    const errors: Error[] = [];
    harness.engine.events.on("error", (error) => errors.push(error));

    const plan = await harness.engine.startTask("edit code");
    await expect(harness.engine.approve(plan.id)).rejects.toBeInstanceOf(
      RetryLimitExceededError,
    );

    expect(harness.engine.status).toBe("error");
    expect(errors[0]).toBeInstanceOf(RetryLimitExceededError);
  });

  it("syncs and checkpoints only after validation passes", async () => {
    const harness = createHarness({ completions: ["plan", "good diff"] });
    const checkpoints: GitCheckpoint[] = [];
    harness.engine.events.on("checkpoint", (checkpoint) => {
      checkpoints.push(checkpoint);
    });

    const plan = await harness.engine.startTask("edit code");
    await harness.engine.approve(plan.id);

    expect(harness.syncedSessions).toEqual(["session-1"]);
    expect(harness.checkpointCalls).toEqual([
      ["session-1", "iquantum: edit code", "id-5"],
    ]);
    expect(checkpoints).toHaveLength(1);
    expect(harness.store.validateRuns).toMatchObject([
      { attempt: 1, exitCode: 0, passed: true },
    ]);
    expect(harness.engine.status).toBe("completed");
  });

  it("returns to implementation after validation fails", async () => {
    const harness = createHarness({
      completions: ["plan", "first diff", "second diff"],
      validationResults: [
        execResult("", "tests failed", 1),
        execResult("ok", "", 0),
      ],
    });

    const plan = await harness.engine.startTask("fix tests");
    await harness.engine.approve(plan.id);

    expect(harness.diffCalls).toEqual(["first diff", "second diff"]);
    expect(harness.store.validateRuns.map((run) => run.passed)).toEqual([
      false,
      true,
    ]);
    expect(
      harness.store.messages.some(
        (message) =>
          message.phase === "validate" &&
          message.content.includes("tests failed"),
      ),
    ).toBe(true);
  });

  it("enters error on unexpected planning failures", async () => {
    const harness = createHarness({
      completions: ["unused"],
      repoMapError: new Error("repo map unavailable"),
    });

    await expect(harness.engine.startTask("plan work")).rejects.toThrow(
      "repo map unavailable",
    );
    expect(harness.engine.status).toBe("error");
  });
});

interface HarnessOptions {
  completions: string[];
  diffFailures?: Error[];
  maxRetries?: number;
  repoMapError?: Error;
  validationResults?: ExecResult[];
}

function createHarness(options: HarnessOptions) {
  let nextId = 1;
  const store = new InMemoryPIVStore();
  const completionCalls: Array<{ phase: string; messages: LLMMessage[] }> = [];
  const diffCalls: string[] = [];
  const syncedSessions: string[] = [];
  const checkpointCalls: string[][] = [];
  const transitions: Array<[string, string]> = [];
  const completions = [...options.completions];
  const diffFailures = [...(options.diffFailures ?? [])];
  const validationResults = [
    ...(options.validationResults ?? [execResult("ok", "", 0)]),
  ];

  const engine = new PIVEngine({
    sessionId: "session-1",
    repoPath: "/repo",
    testCommand: "bun test",
    store,
    llmRouter: {
      async *complete(phase, messages) {
        completionCalls.push({ phase, messages });
        yield completions.shift() ?? "";
      },
    },
    diffEngine: {
      async apply(_sessionId, diff) {
        diffCalls.push(diff);
        const failure = diffFailures.shift();

        if (failure) {
          throw failure;
        }
      },
    },
    sandbox: {
      async exec(_sessionId, command) {
        if (command === "bun test") {
          return validationResults.shift() ?? execResult("ok", "", 0);
        }

        return execResult("", "", 0);
      },
      async syncToHost(sessionId) {
        syncedSessions.push(sessionId);
      },
    },
    gitManager: {
      async checkpoint(sessionId, message, validateRunId) {
        checkpointCalls.push([sessionId, message, validateRunId]);
        return {
          id: `checkpoint-${nextId}`,
          sessionId,
          validateRunId,
          commitHash: "abc123",
          commitMessage: message,
          createdAt: fixedNow,
        };
      },
    },
    repoMapBuilder: async () => {
      if (options.repoMapError) {
        throw options.repoMapError;
      }

      return {
        map: "repo map",
        tokenCount: 2,
        fromCache: false,
      };
    },
    ...(options.maxRetries === undefined
      ? {}
      : { maxRetries: options.maxRetries }),
    now: () => fixedNow,
    createId: () => `id-${nextId++}`,
  });

  engine.events.on("phase_change", (event: PhaseChangeEvent) => {
    transitions.push([event.from, event.to]);
  });

  return {
    checkpointCalls,
    completionCalls,
    diffCalls,
    engine,
    store,
    syncedSessions,
    transitions,
  };
}

function execResult(
  stdout: string,
  stderr: string,
  exitCode: number,
): ExecResult {
  return {
    output: {
      async *[Symbol.asyncIterator]() {
        if (stdout) {
          yield { stream: "stdout" as const, data: stdout };
        }

        if (stderr) {
          yield { stream: "stderr" as const, data: stderr };
        }
      },
    },
    exitCode: Promise.resolve(exitCode),
  };
}
