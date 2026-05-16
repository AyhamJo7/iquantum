import type { GitCheckpoint, Plan, Session } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import type { DaemonClient, ServerStreamFrame } from "../client";
import { runTask } from "./task";

const fixedNow = "2026-05-15T00:00:00.000Z";

describe("runTask", () => {
  it("streams tokens, shows plan, approves, and reports checkpoint", async () => {
    const harness = createHarness({
      frames: [
        { type: "token", delta: "step 1" },
        { type: "token", delta: " step 2" },
        { type: "plan_ready", planId: "plan-1" },
        { type: "phase_change", phase: "implementing" },
        { type: "validate_result", passed: true, attempt: 1 },
        { type: "checkpoint", hash: "abc123" },
      ],
      plans: [fakePlan()],
      promptAnswers: ["y"],
    });

    await runTask(
      "add auth",
      { repo: "/repo" },
      harness.client,
      harness.prompt,
      harness.writer,
    );

    expect(harness.output.join("")).toContain("step 1 step 2");
    expect(harness.output.join("")).toContain("=== Plan ===");
    expect(harness.output.join("")).toContain("plan content");
    expect(harness.output.join("")).toContain("Implementing");
    expect(harness.output.join("")).toContain("tests passed (attempt 1)");
    expect(harness.output.join("")).toContain("Committed: abc123");
    expect(harness.calls).toEqual([
      ["createSession", "/repo", { requireApproval: true, autoApprove: true }],
      ["openStream", "session-1"],
      ["startTask", "session-1", "add auth"],
      ["approve", "session-1"],
    ]);
  });

  it("rejects the first plan and approves the second", async () => {
    const harness = createHarness({
      frames: [
        { type: "plan_ready", planId: "plan-1" },
        { type: "token", delta: "revised" },
        { type: "plan_ready", planId: "plan-2" },
        { type: "checkpoint", hash: "def456" },
      ],
      plans: [fakePlan("plan-1"), fakePlan("plan-2", "revised plan")],
      promptAnswers: ["n", "please split the work", "y"],
    });

    await runTask(
      "refactor",
      { repo: "/repo" },
      harness.client,
      harness.prompt,
      harness.writer,
    );

    expect(harness.output.join("")).toContain("Committed: def456");
    expect(harness.calls).toEqual([
      ["createSession", "/repo", { requireApproval: true, autoApprove: true }],
      ["openStream", "session-1"],
      ["startTask", "session-1", "refactor"],
      ["reject", "session-1", "please split the work"],
      ["approve", "session-1"],
    ]);
  });

  it("destroys the session and returns when the user quits", async () => {
    const harness = createHarness({
      frames: [{ type: "plan_ready", planId: "plan-1" }],
      plans: [fakePlan()],
      promptAnswers: ["q"],
    });

    await runTask("task", {}, harness.client, harness.prompt, harness.writer);

    expect(harness.calls).toContainEqual(["destroySession", "session-1"]);
    expect(harness.output.join("")).not.toContain("Committed");
  });

  it("throws on engine error frame and destroys session", async () => {
    const harness = createHarness({
      frames: [{ type: "error", message: "repo map unavailable" }],
      plans: [fakePlan()],
      promptAnswers: [],
    });

    await expect(
      runTask("task", {}, harness.client, harness.prompt, harness.writer),
    ).rejects.toThrow("repo map unavailable");

    expect(harness.calls).toContainEqual(["destroySession", "session-1"]);
  });

  it("reports a friendly message when the daemon is not running", async () => {
    const harness = createHarness({
      frames: [],
      plans: [],
      promptAnswers: [],
      createSessionError: Object.assign(new Error("connect ENOENT"), {
        code: "ENOENT",
      }),
    });

    await runTask("task", {}, harness.client, harness.prompt, harness.writer);

    expect(harness.output.join("")).toContain("daemon is not running");
    expect(harness.calls).not.toContainEqual(
      expect.arrayContaining(["startTask"]),
    );
  });

  it("uses --repo option as repo path when provided", async () => {
    const harness = createHarness({
      frames: [
        { type: "plan_ready", planId: "plan-1" },
        { type: "checkpoint", hash: "abc" },
      ],
      plans: [fakePlan()],
      promptAnswers: ["y"],
    });

    await runTask(
      "task",
      { repo: "/custom/path" },
      harness.client,
      harness.prompt,
      harness.writer,
    );

    expect(harness.calls[0]).toEqual([
      "createSession",
      "/custom/path",
      { requireApproval: true, autoApprove: true },
    ]);
  });
});

interface HarnessOptions {
  frames: ServerStreamFrame[];
  plans: Plan[];
  promptAnswers: string[];
  createSessionError?: Error;
}

function createHarness(options: HarnessOptions) {
  const calls: unknown[][] = [];
  const output: string[] = [];
  const plans = [...options.plans];
  const prompts = [...options.promptAnswers];

  const client: DaemonClient = {
    async health() {
      return { ok: true };
    },
    async createSession(repoPath, createOptions) {
      calls.push(["createSession", repoPath, createOptions]);

      if (options.createSessionError) {
        throw options.createSessionError;
      }

      return fakeSession();
    },
    async getSession(sessionId) {
      return fakeSession(sessionId);
    },
    async destroySession(sessionId) {
      calls.push(["destroySession", sessionId]);
    },
    async startTask(sessionId, prompt) {
      calls.push(["startTask", sessionId, prompt]);
      return plans.shift() ?? fakePlan();
    },
    async currentPlan() {
      return null;
    },
    async approve(sessionId) {
      calls.push(["approve", sessionId]);
    },
    async reject(sessionId, feedback) {
      calls.push(["reject", sessionId, feedback]);
      return plans.shift() ?? fakePlan();
    },
    async listCheckpoints() {
      return [];
    },
    async restore() {
      return undefined;
    },
    async postMessage() {
      return undefined;
    },
    async postPermission() {
      return undefined;
    },
    async deleteMessages() {
      return undefined;
    },
    async compact() {
      return { compacted: false, summary: null };
    },
    async cancelStream() {
      return undefined;
    },
    openStream(sessionId) {
      calls.push(["openStream", sessionId]);
      const frames = options.frames;
      return (async function* () {
        for (const frame of frames) {
          yield frame;
        }
      })();
    },
  };

  const prompt = async (question: string): Promise<string> => {
    const answer = prompts.shift();

    if (answer === undefined) {
      throw new Error(`Unexpected prompt: ${question}`);
    }

    return answer;
  };

  const writer = {
    write: (chunk: string) => output.push(chunk),
    writeln: (line: string) => output.push(`${line}\n`),
  };

  return { calls, client, output, prompt, writer };
}

function fakeSession(sessionId = "session-1"): Session {
  return {
    id: sessionId,
    status: "idle",
    repoPath: "/repo",
    containerId: "container-1",
    volumeId: "volume-1",
    config: {},
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };
}

function fakePlan(id = "plan-1", content = "plan content"): Plan {
  return {
    id,
    sessionId: "session-1",
    content,
    status: "pending",
    feedback: null,
    createdAt: fixedNow,
    approvedAt: null,
  };
}

function _fakeCheckpoint(): GitCheckpoint {
  return {
    id: "checkpoint-1",
    sessionId: "session-1",
    validateRunId: "run-1",
    commitHash: "abc123",
    commitMessage: "iquantum: add auth",
    createdAt: fixedNow,
  };
}
