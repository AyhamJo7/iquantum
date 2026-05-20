import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitManager, InMemoryGitCheckpointStore } from "@iquantum/git";
import type {
  PIVEngineEventMap,
  PIVEngineOptions,
  PIVStore,
} from "@iquantum/piv-engine";
import type { Plan, Session, SessionStatus } from "@iquantum/types";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionStore } from "./db/stores";
import {
  type CurrentPlanStore,
  OverlappingRepoError,
  SessionController,
  type SessionEngine,
  type SessionGitManager,
} from "./session-controller";

const run = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SessionController", () => {
  it("creates a persisted live session and wires a PIV engine", async () => {
    const harness = createHarness();

    const session = await harness.controller.createSession("/repo");

    expect(session).toMatchObject({
      id: "session-1",
      repoPath: "/repo",
      status: "idle",
      mode: "piv",
      config: {
        testCommand: "bun test",
        requireApproval: false,
        autoApprove: false,
      },
    });
    expect(harness.createdSandboxes).toEqual([["session-1", "/repo"]]);
    expect(harness.engineOptions).toMatchObject({
      repoPath: "/repo",
      sessionId: "session-1",
      testCommand: "bun test",
      maxRetries: 3,
    });
    await expect(harness.controller.getSession("session-1")).resolves.toEqual(
      session,
    );
  });

  it("passes approval settings into the persisted session and engine", async () => {
    const harness = createHarness();

    const session = await harness.controller.createSession("/repo", {
      requireApproval: true,
      autoApprove: true,
    });

    expect(session.config).toMatchObject({
      requireApproval: true,
      autoApprove: true,
    });
    expect(harness.engineOptions).toMatchObject({
      requireApproval: true,
      autoApprove: true,
    });
  });

  it("stores chat mode when requested", async () => {
    const harness = createHarness();

    const session = await harness.controller.createSession("/repo", {
      mode: "chat",
    });

    expect(session.mode).toBe("chat");
  });

  it("creates worktree sessions from a dedicated worktree path", async () => {
    const harness = createHarness();

    const session = await harness.controller.createSession("/repo", {
      worktree: true,
    });

    expect(session.worktreePath).toBe("/tmp/wt-session-1");
    expect(session.worktreeBranch).toBe("iquantum/session-1");
    expect(session.startCheckpointHash).toBe("abc123");
    expect(harness.worktreeCalls).toEqual([["createWorktree", "session-1"]]);
    expect(harness.createdSandboxes).toEqual([
      ["session-1", "/tmp/wt-session-1"],
    ]);
    expect(harness.gitManagerPaths).toEqual(["/repo", "/tmp/wt-session-1"]);
    expect(harness.engineOptions).toMatchObject({
      repoPath: "/tmp/wt-session-1",
    });
  });

  it("removes a worktree before destroying the sandbox", async () => {
    const harness = createHarness();
    await harness.controller.createSession("/repo", { worktree: true });

    await harness.controller.destroySession("session-1");

    expect(harness.lifecycleCalls).toEqual([
      "removeWorktree:/tmp/wt-session-1:iquantum/session-1",
      "destroySandbox:session-1",
    ]);
  });

  it("continues destroying a session when worktree removal fails", async () => {
    const harness = createHarness({
      removeWorktreeError: new Error("worktree already gone"),
    });
    await harness.controller.createSession("/repo", { worktree: true });

    await harness.controller.destroySession("session-1");

    expect(harness.lifecycleCalls).toEqual([
      "removeWorktree:/tmp/wt-session-1:iquantum/session-1",
      "destroySandbox:session-1",
    ]);
    await expect(harness.controller.getSession("session-1")).rejects.toThrow(
      "Unknown session session-1",
    );
  });

  it("rolls back a created worktree when sandbox creation fails", async () => {
    const sandboxError = new Error("sandbox failed");
    const harness = createHarness({ createSandboxError: sandboxError });

    await expect(
      harness.controller.createSession("/repo", { worktree: true }),
    ).rejects.toBe(sandboxError);

    expect(harness.worktreeCalls).toEqual([
      ["createWorktree", "session-1"],
      ["removeWorktree", "/tmp/wt-session-1", "iquantum/session-1"],
    ]);
  });

  it("preserves the sandbox error when rollback worktree removal also fails", async () => {
    const sandboxError = new Error("sandbox failed");
    const harness = createHarness({
      createSandboxError: sandboxError,
      removeWorktreeError: new Error("rollback failed"),
    });

    await expect(
      harness.controller.createSession("/repo", { worktree: true }),
    ).rejects.toBe(sandboxError);
  });

  it("rolls back sandbox and worktree when session persistence fails", async () => {
    const persistenceError = new Error("insert failed");
    const harness = createHarness({
      createSessionStoreError: persistenceError,
    });

    await expect(
      harness.controller.createSession("/repo", { worktree: true }),
    ).rejects.toBe(persistenceError);

    expect(harness.lifecycleCalls).toEqual([
      "removeWorktree:/tmp/wt-session-1:iquantum/session-1",
      "destroySandbox:session-1",
    ]);
  });

  it("does not remove a worktree for a regular session", async () => {
    const harness = createHarness();
    await harness.controller.createSession("/repo");

    await harness.controller.destroySession("session-1");

    expect(harness.lifecycleCalls).toEqual(["destroySandbox:session-1"]);
    expect(harness.worktreeCalls).toEqual([]);
  });

  it("rejects worktree sessions that include the primary repo as an extra repo", async () => {
    const harness = createHarness();

    await expect(
      harness.controller.createSession("/repo", {
        worktree: true,
        extraRepoPaths: ["/repo"],
      }),
    ).rejects.toBeInstanceOf(OverlappingRepoError);
    expect(harness.createdSandboxes).toEqual([]);
  });

  it("creates two worktree sessions on the same repo with independent commits", async () => {
    const repoPath = await makeRepo();
    const ids = ["session-1", "session-2"];
    const harness = createHarness({
      createId: () => ids.shift() ?? crypto.randomUUID(),
      createGitManager: (managerRepoPath, gitCheckpointStore) =>
        new GitManager({
          repoPath: managerRepoPath,
          store: gitCheckpointStore,
        }),
    });

    const first = await harness.controller.createSession(repoPath, {
      worktree: true,
    });
    const second = await harness.controller.createSession(repoPath, {
      worktree: true,
    });

    expect(first.worktreePath).toBeTruthy();
    expect(second.worktreePath).toBeTruthy();
    expect(first.worktreePath).not.toBe(second.worktreePath);

    await commitReadme(
      first.worktreePath as string,
      "first session\n",
      "first",
    );
    await commitReadme(
      second.worktreePath as string,
      "second session\n",
      "second",
    );

    const firstHead = (
      await run("git", ["rev-parse", "iquantum/session-1"], { cwd: repoPath })
    ).stdout.trim();
    const secondHead = (
      await run("git", ["rev-parse", "iquantum/session-2"], { cwd: repoPath })
    ).stdout.trim();

    expect(firstHead).toMatch(/^[0-9a-f]{40}$/);
    expect(secondHead).toMatch(/^[0-9a-f]{40}$/);
    expect(firstHead).not.toBe(secondHead);
    await expect(readFile(join(repoPath, "README.md"), "utf8")).resolves.toBe(
      "initial\n",
    );

    await harness.controller.destroySession("session-1");
    await harness.controller.destroySession("session-2");

    const branches = (
      await run("git", ["branch", "--list", "iquantum/session-*"], {
        cwd: repoPath,
      })
    ).stdout.trim();
    expect(branches).toBe("");
  });

  it("passes file tools to the PIV engine when enabled", async () => {
    const harness = createHarness({ fileToolMaxBytes: 4096 });

    await harness.controller.createSession("/repo");

    expect(
      harness.engineOptions?.fileTools?.getAll().map((tool) => tool.name),
    ).toEqual([
      "file_read",
      "file_edit",
      "file_write",
      "file_glob",
      "file_grep",
    ]);
  });

  it("passes web tools and rate limiter to the PIV engine", async () => {
    const webTools = { getAll: () => [] };
    const webSearchRateLimiter = {
      async consume() {
        return { allowed: true, remaining: 9, resetAt: Date.now() + 60_000 };
      },
    };
    const harness = createHarness({
      webTools: webTools as never,
      webSearchRateLimiter: webSearchRateLimiter as never,
    });

    await harness.controller.createSession("/repo");

    expect(harness.engineOptions?.webTools).toBe(webTools);
    expect(harness.engineOptions?.webToolRateLimiter).toBe(
      webSearchRateLimiter,
    );
  });

  it("fetches a fresh memory block on each startTask call", async () => {
    let callCount = 0;
    const harness = createHarness({
      memoryManager: {
        async buildBlock() {
          callCount += 1;
          return { text: `memory snapshot ${callCount}`, tokenCount: 5 };
        },
      },
    });

    await harness.controller.createSession("/repo");
    await harness.controller.startTask("session-1", "task one");
    await harness.controller.startTask("session-1", "task two");

    expect(harness.engineCalls[0]).toEqual([
      "startTask",
      "task one",
      { memoryBlock: "memory snapshot 1" },
    ]);
    expect(harness.engineCalls[1]).toEqual([
      "startTask",
      "task two",
      { memoryBlock: "memory snapshot 2" },
    ]);
  });

  it("delegates plan actions to the live engine and reads the pending plan", async () => {
    const harness = createHarness();
    await harness.controller.createSession("/repo");

    await harness.controller.startTask("session-1", "add auth");
    const plan = await harness.controller.currentPlan("session-1");
    await harness.controller.approve("session-1");
    await harness.controller.reject("session-1", "split it", "plan-1");

    expect(plan?.id).toBe("plan-1");
    expect(harness.engineCalls[0]).toEqual([
      "startTask",
      "add auth",
      { memoryBlock: undefined },
    ]);
    expect(harness.engineCalls[1]).toEqual(["approve", "plan-1"]);
    expect(harness.engineCalls[2]).toEqual(["reject", "plan-1", "split it"]);
  });

  it("updateConfig updates effort in DB and live session", async () => {
    const harness = createHarness();
    await harness.controller.createSession("/repo");

    const updated = await harness.controller.updateConfig("session-1", {
      effort: "fast",
    });

    expect(updated.effort).toBe("fast");
    expect(harness.effortCalls).toEqual(["fast"]);
  });

  describe("getDiff", () => {
    it("runs git diff <from> --unified=3 when only from is provided", async () => {
      const execCalls: string[] = [];
      const harness = createHarness({
        exec(_, command) {
          execCalls.push(command);
          return fakeExecResult("diff output", "", 0);
        },
      });
      await harness.controller.createSession("/repo");

      const result = await harness.controller.getDiff("session-1", "abc1234");

      expect(execCalls).toEqual(["git diff abc1234 --unified=3"]);
      expect(result).toBe("diff output");
    });

    it("runs git diff <from> <to> --unified=3 when both refs are provided", async () => {
      const execCalls: string[] = [];
      const harness = createHarness({
        exec(_, command) {
          execCalls.push(command);
          return fakeExecResult("range diff", "", 0);
        },
      });
      await harness.controller.createSession("/repo");

      const result = await harness.controller.getDiff(
        "session-1",
        "abc1234",
        "def5678",
      );

      expect(execCalls).toEqual(["git diff abc1234 def5678 --unified=3"]);
      expect(result).toBe("range diff");
    });

    it("runs git diff HEAD --unified=3 when no refs are provided", async () => {
      const execCalls: string[] = [];
      const harness = createHarness({
        exec(_, command) {
          execCalls.push(command);
          return fakeExecResult("head diff", "", 0);
        },
      });
      await harness.controller.createSession("/repo");

      const result = await harness.controller.getDiff("session-1");

      expect(execCalls).toEqual(["git diff HEAD --unified=3"]);
      expect(result).toBe("head diff");
    });

    it("throws when git diff exits non-zero and stdout is empty", async () => {
      const harness = createHarness({
        exec() {
          return fakeExecResult("", "fatal: not a git repo", 128);
        },
      });
      await harness.controller.createSession("/repo");

      await expect(
        harness.controller.getDiff("session-1", "abc1234"),
      ).rejects.toThrow("git diff failed (exit 128)");
    });

    it("returns stdout even when exit code is non-zero (partial diff)", async () => {
      const harness = createHarness({
        exec() {
          return fakeExecResult("partial diff output", "some warning", 1);
        },
      });
      await harness.controller.createSession("/repo");

      const result = await harness.controller.getDiff("session-1", "abc1234");

      expect(result).toBe("partial diff output");
    });

    it("throws for an invalid from ref before touching the sandbox", async () => {
      let execCalled = false;
      const harness = createHarness({
        exec() {
          execCalled = true;
          return fakeExecResult("", "", 0);
        },
      });
      await harness.controller.createSession("/repo");

      await expect(
        harness.controller.getDiff("session-1", "HEAD; rm -rf /"),
      ).rejects.toThrow("Invalid git ref");
      expect(execCalled).toBe(false);
    });

    it("throws for an invalid to ref before touching the sandbox", async () => {
      let execCalled = false;
      const harness = createHarness({
        exec() {
          execCalled = true;
          return fakeExecResult("", "", 0);
        },
      });
      await harness.controller.createSession("/repo");

      await expect(
        harness.controller.getDiff("session-1", "abc1234", "$(evil)"),
      ).rejects.toThrow("Invalid git ref");
      expect(execCalled).toBe(false);
    });
  });
});

function fakeExecResult(
  stdout: string,
  stderr: string,
  exitCode: number,
): {
  output: AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
  exitCode: Promise<number>;
} {
  return {
    output: (async function* () {
      if (stdout) yield { stream: "stdout" as const, data: stdout };
      if (stderr) yield { stream: "stderr" as const, data: stderr };
    })(),
    exitCode: Promise.resolve(exitCode),
  };
}

function createHarness(
  options: {
    fileToolMaxBytes?: number;
    webTools?: ConstructorParameters<typeof SessionController>[0]["webTools"];
    webSearchRateLimiter?: ConstructorParameters<
      typeof SessionController
    >[0]["webSearchRateLimiter"];
    memoryManager?: ConstructorParameters<
      typeof SessionController
    >[0]["memoryManager"];
    exec?: (
      sessionId: string,
      command: string,
    ) => ReturnType<typeof fakeExecResult>;
    createSandboxError?: Error;
    createSessionStoreError?: Error;
    removeWorktreeError?: Error;
    createId?: () => string;
    createGitManager?: (
      repoPath: string,
      gitCheckpointStore: InMemoryGitCheckpointStore,
    ) => SessionGitManager;
  } = {},
) {
  const sessions = new Map<string, Session>();
  const plans = new Map<string, Plan>();
  const createdSandboxes: string[][] = [];
  const gitManagerPaths: string[] = [];
  const lifecycleCalls: string[] = [];
  const worktreeCalls: unknown[][] = [];
  const engineCalls: unknown[][] = [];
  const effortCalls: string[] = [];
  let engineOptions: PIVEngineOptions | undefined;
  const plan = fakePlan();
  plans.set(plan.id, plan);

  const sessionStore: SessionStore = {
    async insert(session) {
      if (options.createSessionStoreError) {
        throw options.createSessionStoreError;
      }
      sessions.set(session.id, session);
    },
    async get(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async update(sessionId, updates) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`Unknown session ${sessionId}`);
      Object.assign(session, updates);
      return session;
    },
    async delete(sessionId) {
      sessions.delete(sessionId);
    },
    async listByOrg(orgId) {
      return [...sessions.values()].filter(
        (session) => session.orgId === orgId,
      );
    },
  };
  const pivStore: PIVStore & CurrentPlanStore = {
    async updateSessionStatus(sessionId, status: SessionStatus) {
      const session = sessions.get(sessionId);

      if (session) {
        session.status = status;
      }
    },
    async insertMessage() {
      return undefined;
    },
    async listMessagesByTask() {
      return [];
    },
    async insertPlan(nextPlan) {
      plans.set(nextPlan.id, nextPlan);
    },
    async getPlan(planId) {
      return plans.get(planId) ?? null;
    },
    async updatePlan(planId, updates) {
      const existing = plans.get(planId);

      if (!existing) {
        throw new Error("missing plan");
      }

      Object.assign(existing, updates);
      return existing;
    },
    async insertValidateRun() {
      return undefined;
    },
    async getCurrentPlan() {
      return plan;
    },
  };
  const gitManager: SessionGitManager = {
    async checkpoint() {
      throw new Error("not used");
    },
    async listCheckpoints() {
      return { checkpoints: [], nextCursor: null };
    },
    async restore() {
      return undefined;
    },
    async currentHead() {
      return "abc123";
    },
    async createWorktree(sessionId) {
      worktreeCalls.push(["createWorktree", sessionId]);
      return {
        worktreePath: `/tmp/wt-${sessionId}`,
        branch: `iquantum/${sessionId}`,
      };
    },
    async removeWorktree(worktreePath, branch) {
      worktreeCalls.push(["removeWorktree", worktreePath, branch]);
      lifecycleCalls.push(`removeWorktree:${worktreePath}:${branch}`);
      if (options.removeWorktreeError) {
        throw options.removeWorktreeError;
      }
    },
  };

  const gitCheckpointStore = new InMemoryGitCheckpointStore();
  const controller = new SessionController({
    sessionStore,
    pivStore,
    gitCheckpointStore,
    sandbox: {
      async createSandbox(sessionId, repoPath) {
        createdSandboxes.push([sessionId, repoPath]);
        if (options.createSandboxError) {
          throw options.createSandboxError;
        }
        return {
          sessionId,
          repoPath,
          containerName: `container-${sessionId}`,
          volumeName: `volume-${sessionId}`,
        };
      },
      async destroySandbox(sessionId) {
        lifecycleCalls.push(`destroySandbox:${sessionId}`);
        return undefined;
      },
      async exec(sessionId, command) {
        if (options.exec) return options.exec(sessionId, command);
        throw new Error("not used");
      },
      async syncToHost() {
        return undefined;
      },
    },
    llmRouterFactory: () => ({
      async *complete() {
        yield "";
      },
    }),
    createEngine(options) {
      engineOptions = options;
      return fakeEngine(engineCalls, effortCalls);
    },
    createGitManager: (repoPath) => {
      gitManagerPaths.push(repoPath);
      if (options.createGitManager) {
        return options.createGitManager(repoPath, gitCheckpointStore);
      }
      return gitManager;
    },
    ...(options.fileToolMaxBytes === undefined
      ? {}
      : { fileToolMaxBytes: options.fileToolMaxBytes }),
    ...(options.webTools === undefined ? {} : { webTools: options.webTools }),
    ...(options.webSearchRateLimiter === undefined
      ? {}
      : { webSearchRateLimiter: options.webSearchRateLimiter }),
    ...(options.memoryManager === undefined
      ? {}
      : { memoryManager: options.memoryManager }),
    maxRetries: 3,
    loadTestCommand: async () => "bun test",
    now: () => "2026-05-15T00:00:00.000Z",
    createId: options.createId ?? (() => "session-1"),
  });

  return {
    controller,
    createdSandboxes,
    gitManagerPaths,
    lifecycleCalls,
    worktreeCalls,
    engineCalls,
    effortCalls,
    get engineOptions() {
      return engineOptions;
    },
  };
}

async function makeRepo(): Promise<string> {
  const basePath = await mkdtempInTmp("iquantum-session-controller-");
  const repoPath = join(basePath, "repo");
  await mkdir(repoPath);
  await run("git", ["init"], { cwd: repoPath });
  await run("git", ["config", "user.name", "Iquantum Test"], {
    cwd: repoPath,
  });
  await run("git", ["config", "user.email", "test@iquantum.local"], {
    cwd: repoPath,
  });
  await writeFile(join(repoPath, "README.md"), "initial\n", "utf8");
  await run("git", ["add", "-A"], { cwd: repoPath });
  await run("git", ["commit", "-m", "initial"], { cwd: repoPath });
  return repoPath;
}

async function mkdtempInTmp(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function commitReadme(
  repoPath: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(repoPath, "README.md"), content, "utf8");
  await run("git", ["add", "-A"], { cwd: repoPath });
  await run("git", ["commit", "-m", message], { cwd: repoPath });
}

function fakeEngine(calls: unknown[][], effortCalls: string[]): SessionEngine {
  return {
    status: "idle",
    currentPlan: fakePlan(),
    events: new EventEmitter<PIVEngineEventMap>(),
    async startTask(prompt, options) {
      calls.push(["startTask", prompt, options]);
      return fakePlan();
    },
    async approve(planId) {
      calls.push(["approve", planId]);
    },
    async reject(planId, feedback) {
      calls.push(["reject", planId, feedback]);
      return fakePlan();
    },
    setEffort(effort) {
      effortCalls.push(effort);
    },
  };
}

function fakePlan(): Plan {
  return {
    id: "plan-1",
    sessionId: "session-1",
    content: "plan",
    status: "pending",
    feedback: null,
    createdAt: "2026-05-15T00:00:00.000Z",
    approvedAt: null,
  };
}
