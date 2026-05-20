import { DiffApplyError } from "@iquantum/diff-engine";
import type { ExecResult } from "@iquantum/sandbox";
import type {
  CompletionEvent,
  GitCheckpoint,
  LLMMessage,
} from "@iquantum/types";
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

  it("previews diffs and waits for approval before applying them", async () => {
    const harness = createHarness({
      completions: ["plan", validDiff()],
      requireApproval: true,
    });
    const previews: Array<{ file: string; patch: string }> = [];
    harness.engine.events.on("diff_preview", (preview) => {
      previews.push(preview);
    });

    const plan = await harness.engine.startTask("edit code");
    await harness.engine.approve(plan.id);

    expect(previews).toMatchObject([{ file: "src/a.ts" }]);
    expect(harness.permissionRequests).toEqual([
      {
        sessionId: "session-1",
        requestId: "id-5",
        tool: "apply_diff",
        input: { files: ["src/a.ts"] },
        options: { autoApprove: false },
      },
    ]);
    expect(harness.diffCalls).toEqual([validDiff()]);
  });

  it("uses file tools during implementation and then applies the final diff", async () => {
    const harness = createHarness({
      completions: ["plan"],
      toolEvents: [
        [
          {
            type: "tool_use",
            id: "tool-1",
            name: "file_read",
            input: { path: "src/a.ts" },
          },
        ],
        [{ type: "token", delta: validDiff() }],
      ],
      fileToolResult: "src/a.ts (lines 1-1):\n1\told",
    });
    const toolCalls: unknown[] = [];
    harness.engine.events.on("tool_call", (event) => toolCalls.push(event));

    const plan = await harness.engine.startTask("edit code");
    await harness.engine.approve(plan.id);

    expect(toolCalls).toEqual([
      {
        toolName: "file_read",
        input: { path: "src/a.ts" },
        result: "src/a.ts (lines 1-1):\n1\told",
      },
    ]);
    expect(harness.diffCalls).toEqual([validDiff()]);
    expect(harness.toolCompletionCalls).toHaveLength(2);
  });

  it("uses web tools during planning", async () => {
    const harness = createHarness({
      completions: [],
      webToolResult: "1. Bun\n   https://bun.sh\n   release notes",
      toolEvents: [
        [
          {
            type: "tool_use",
            id: "web-1",
            name: "web_search",
            input: { query: "latest bun" },
          },
        ],
        [{ type: "token", delta: "plan with web context" }],
      ],
      webTools: true,
    });
    const toolCalls: unknown[] = [];
    harness.engine.events.on("tool_call", (event) => toolCalls.push(event));

    const plan = await harness.engine.startTask("research Bun");

    expect(plan.content).toBe("plan with web context");
    expect(toolCalls).toEqual([
      {
        toolName: "web_search",
        input: { query: "latest bun" },
        result: "1. Bun\n   https://bun.sh\n   release notes",
      },
    ]);
    expect(harness.toolCompletionCalls.map((call) => call.phase)).toEqual([
      "plan",
      "plan",
    ]);
  });

  it("does not expose web tools during implementation", async () => {
    const harness = createHarness({
      completions: [validDiff()],
      toolEvents: [[{ type: "token", delta: "plan" }]],
      webTools: true,
    });

    const plan = await harness.engine.startTask("edit code");
    await harness.engine.approve(plan.id);

    expect(harness.toolCompletionCalls).toEqual([
      {
        phase: "plan",
        messages: expect.any(Array),
        tools: ["web_fetch", "web_search"],
      },
    ]);
    expect(harness.diffCalls).toEqual([validDiff()]);
  });

  it("rate-limits web_search during planning", async () => {
    const rateLimiter = {
      consume: async () => ({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60_000,
      }),
    };
    const harness = createHarness({
      completions: [],
      toolEvents: [
        [
          {
            type: "tool_use",
            id: "web-1",
            name: "web_search",
            input: { query: "latest bun" },
          },
        ],
        [{ type: "token", delta: "plan" }],
      ],
      webTools: true,
      webToolRateLimiter: rateLimiter,
    });
    const toolCalls: unknown[] = [];
    harness.engine.events.on("tool_call", (event) => toolCalls.push(event));

    await harness.engine.startTask("research Bun");

    expect(toolCalls).toMatchObject([
      {
        toolName: "web_search",
        result: "Error: web_search rate limit exceeded.",
      },
    ]);
  });

  it("falls back to plain completion when no file tools are configured", async () => {
    const harness = createHarness({ completions: ["plan", validDiff()] });
    const toolCalls: unknown[] = [];
    harness.engine.events.on("tool_call", (event) => toolCalls.push(event));

    const plan = await harness.engine.startTask("edit code");
    await harness.engine.approve(plan.id);

    expect(toolCalls).toEqual([]);
    expect(harness.toolCompletionCalls).toEqual([]);
    expect(harness.diffCalls).toEqual([validDiff()]);
  });

  it("injects memory into architect planning prompts", async () => {
    const harness = createHarness({
      completions: ["plan"],
      memoryBlock: "this project uses Bun",
    });

    await harness.engine.startTask("edit code");

    expect(harness.completionCalls[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("## Your Memory"),
    });
    expect(String(harness.completionCalls[0]?.messages[0]?.content)).toContain(
      "this project uses Bun",
    );
  });

  it("retries implementation without writing when the user rejects a diff", async () => {
    const harness = createHarness({
      completions: ["plan", validDiff(), validDiff("next")],
      requireApproval: true,
      permissionResults: [false, true],
    });

    const plan = await harness.engine.startTask("edit code");
    await harness.engine.approve(plan.id);

    expect(harness.diffCalls).toEqual([validDiff("next")]);
    expect(
      harness.store.messages.some((message) =>
        message.content.includes("User rejected"),
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
  fileToolResult?: string;
  webToolResult?: string;
  diffFailures?: Error[];
  maxRetries?: number;
  permissionResults?: boolean[];
  requireApproval?: boolean;
  repoMapError?: Error;
  toolEvents?: CompletionEvent[][];
  validationResults?: ExecResult[];
  memoryBlock?: string;
  webTools?: boolean;
  webToolRateLimiter?: ConstructorParameters<
    typeof PIVEngine
  >[0]["webToolRateLimiter"];
}

function createHarness(options: HarnessOptions) {
  let nextId = 1;
  const store = new InMemoryPIVStore();
  const completionCalls: Array<{ phase: string; messages: LLMMessage[] }> = [];
  const toolCompletionCalls: Array<{
    phase: string;
    messages: LLMMessage[];
    tools: string[];
  }> = [];
  const diffCalls: string[] = [];
  const syncedSessions: string[] = [];
  const checkpointCalls: string[][] = [];
  const transitions: Array<[string, string]> = [];
  const permissionRequests: unknown[] = [];
  const completions = [...options.completions];
  const diffFailures = [...(options.diffFailures ?? [])];
  const validationResults = [
    ...(options.validationResults ?? [execResult("ok", "", 0)]),
  ];
  const toolEvents = [...(options.toolEvents ?? [])];
  const permissionResults = [...(options.permissionResults ?? [true])];

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
      async *completeWithTools(phase, messages, tools) {
        toolCompletionCalls.push({
          phase,
          messages,
          tools: tools.map((tool) => tool.name),
        });

        for (const event of toolEvents.shift() ?? []) {
          yield event;
        }
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
    permissionGate: {
      async requestPermission(sessionId, requestId, tool, input, options) {
        permissionRequests.push({
          sessionId,
          requestId,
          tool,
          input,
          options,
        });
        return permissionResults.shift() ?? true;
      },
    },
    ...(options.requireApproval === undefined
      ? {}
      : { requireApproval: options.requireApproval }),
    ...(options.fileToolResult === undefined
      ? {}
      : {
          fileTools: {
            getAll: () => [
              {
                name: "file_read",
                description: "read",
                inputSchema: { type: "object" },
                async execute() {
                  return options.fileToolResult ?? "file result";
                },
              },
            ],
          } as never,
        }),
    ...(options.webTools === undefined
      ? {}
      : {
          webTools: {
            getAll: () => [
              {
                name: "web_fetch",
                description: "fetch",
                inputSchema: { type: "object" },
                async execute() {
                  return "fetched";
                },
              },
              {
                name: "web_search",
                description: "search",
                inputSchema: { type: "object" },
                async execute() {
                  return options.webToolResult ?? "search results";
                },
              },
            ],
          } as never,
        }),
    ...(options.webToolRateLimiter === undefined
      ? {}
      : { webToolRateLimiter: options.webToolRateLimiter }),
    ...(options.memoryBlock === undefined
      ? {}
      : { memoryBlock: options.memoryBlock }),
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
    toolCompletionCalls,
    transitions,
    permissionRequests,
  };
}

function validDiff(replacement = "next"): string {
  return [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    `+${replacement}`,
  ].join("\n");
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
