import { InMemoryPIVStore, PIVEngine } from "@iquantum/piv-engine";
import type { ExecResult } from "@iquantum/sandbox";
import { describe, expect, it } from "vitest";
import { PermissionGate } from "./permission-gate";

describe("permission flow", () => {
  it("blocks PIV writes until a later permission response approves them", async () => {
    const frames: unknown[] = [];
    const writes: string[] = [];
    let nextId = 1;
    const gate = new PermissionGate({
      publish(_sessionId, frame) {
        frames.push(frame);
      },
    });
    const engine = new PIVEngine({
      sessionId: "session-1",
      repoPath: "/repo",
      testCommand: "bun test",
      store: new InMemoryPIVStore(),
      llmRouter: {
        async *complete(phase) {
          yield phase === "plan" ? "plan" : validDiff();
        },
      },
      diffEngine: {
        async apply(_sessionId, diff) {
          writes.push(diff);
        },
      },
      sandbox: {
        async exec() {
          return execResult();
        },
        async syncToHost() {
          return undefined;
        },
      },
      gitManager: {
        async checkpoint(sessionId, commitMessage, validateRunId) {
          return {
            id: "checkpoint-1",
            sessionId,
            validateRunId,
            commitHash: "abc1234",
            commitMessage,
            createdAt: "2026-05-16T00:00:00.000Z",
          };
        },
      },
      repoMapBuilder: async () => ({
        map: "repo map",
        tokenCount: 2,
        fromCache: false,
      }),
      permissionGate: gate,
      requireApproval: true,
      createId: () => `id-${nextId++}`,
      now: () => "2026-05-16T00:00:00.000Z",
    });

    const plan = await engine.startTask("edit code");
    const approval = engine.approve(plan.id);
    await waitFor(() => frames.length === 1);

    expect(writes).toEqual([]);
    expect(frames).toMatchObject([
      {
        type: "permission_request",
        requestId: "id-5",
        tool: "apply_diff",
      },
    ]);

    gate.resolvePermission("session-1", "id-5", true);
    await approval;

    expect(writes).toEqual([validDiff()]);
  });

  it("retries without writing after a rejected diff", async () => {
    const frames: Array<{ requestId?: string; type: string }> = [];
    const writes: string[] = [];
    let nextId = 1;
    const gate = new PermissionGate({
      publish(_sessionId, frame) {
        frames.push(frame);
      },
    });
    const diffs = [validDiff("first"), validDiff("second")];
    const engine = new PIVEngine({
      sessionId: "session-1",
      repoPath: "/repo",
      testCommand: "bun test",
      store: new InMemoryPIVStore(),
      llmRouter: {
        async *complete(phase) {
          yield phase === "plan" ? "plan" : (diffs.shift() ?? "");
        },
      },
      diffEngine: {
        async apply(_sessionId, diff) {
          writes.push(diff);
        },
      },
      sandbox: {
        async exec() {
          return execResult();
        },
        async syncToHost() {
          return undefined;
        },
      },
      gitManager: {
        async checkpoint(sessionId, commitMessage, validateRunId) {
          return {
            id: "checkpoint-1",
            sessionId,
            validateRunId,
            commitHash: "abc1234",
            commitMessage,
            createdAt: "2026-05-16T00:00:00.000Z",
          };
        },
      },
      repoMapBuilder: async () => ({
        map: "repo map",
        tokenCount: 2,
        fromCache: false,
      }),
      permissionGate: gate,
      requireApproval: true,
      createId: () => `id-${nextId++}`,
      now: () => "2026-05-16T00:00:00.000Z",
    });

    const plan = await engine.startTask("edit code");
    const approval = engine.approve(plan.id);
    await waitFor(() => frames.length === 1);

    gate.resolvePermission("session-1", frames[0]?.requestId ?? "", false);
    await waitFor(() => frames.length === 2);

    expect(writes).toEqual([]);

    gate.resolvePermission("session-1", frames[1]?.requestId ?? "", true);
    await approval;

    expect(writes).toEqual([validDiff("second")]);
  });
});

function validDiff(replacement = "next"): string {
  return [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    `+${replacement}`,
  ].join("\n");
}

function execResult(): ExecResult {
  return {
    output: {
      async *[Symbol.asyncIterator]() {
        yield { stream: "stdout" as const, data: "ok" };
      },
    },
    exitCode: Promise.resolve(0),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("condition was not met");
}
