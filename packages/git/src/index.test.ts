import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitManager, InMemoryGitCheckpointStore } from "./index";

const run = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("GitManager", () => {
  it("creates, lists, and restores checkpoints", async () => {
    const repoPath = await makeRepo();
    const store = new InMemoryGitCheckpointStore();
    const manager = new GitManager({
      repoPath,
      store,
      now: () => "2026-05-15T00:00:00.000Z",
      createId: () => "checkpoint-1",
    });

    await writeFile(join(repoPath, "README.md"), "changed\n", "utf8");
    const checkpoint = await manager.checkpoint(
      "session-1",
      "apply validated edit",
      "validate-1",
    );

    expect(checkpoint).toMatchObject({
      id: "checkpoint-1",
      sessionId: "session-1",
      validateRunId: "validate-1",
      commitMessage: "apply validated edit",
    });
    await expect(manager.listCheckpoints("session-1")).resolves.toEqual({
      checkpoints: [checkpoint],
      nextCursor: null,
    });

    await writeFile(join(repoPath, "README.md"), "dirty\n", "utf8");
    await manager.restore(checkpoint.commitHash);

    await expect(readFile(join(repoPath, "README.md"), "utf8")).resolves.toBe(
      "changed\n",
    );
  });

  it("returns a diff between refs", async () => {
    const repoPath = await makeRepo();
    const store = new InMemoryGitCheckpointStore();
    const manager = new GitManager({ repoPath, store });
    const before = await manager.currentHead();
    await writeFile(join(repoPath, "README.md"), "# test\n\nchanged\n");
    await manager.checkpoint("session-1", "change readme", "validate-1");
    const after = await manager.currentHead();

    await expect(manager.diff(before, after)).resolves.toContain("+changed");
  });
});

describe("GitManager worktree methods", () => {
  it("currentHead returns the HEAD commit hash", async () => {
    const repoPath = await makeRepo();
    const manager = new GitManager({
      repoPath,
      store: new InMemoryGitCheckpointStore(),
    });

    const head = await manager.currentHead();

    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("createWorktree, listWorktrees, removeWorktree round-trip", async () => {
    const repoPath = await makeRepo();
    const worktreePath = await mkdtemp(join(tmpdir(), "iquantum-wt-"));
    tempDirs.push(worktreePath);

    const manager = new GitManager({
      repoPath,
      store: new InMemoryGitCheckpointStore(),
    });

    await manager.createWorktree(worktreePath, "iquantum/session-test");

    const worktrees = await manager.listWorktrees();
    const added = worktrees.find((w) => w.worktreePath === worktreePath);

    expect(added).toBeDefined();
    expect(added?.branch).toBe("iquantum/session-test");
    expect(added?.worktreePath).toBe(worktreePath);
    expect(added?.commitHash).toMatch(/^[0-9a-f]{40}$/);

    await manager.removeWorktree(worktreePath);

    const afterRemove = await manager.listWorktrees();
    expect(
      afterRemove.find((w) => w.worktreePath === worktreePath),
    ).toBeUndefined();
    const branches = await run(
      "git",
      ["branch", "--list", "iquantum/session-test"],
      {
        cwd: repoPath,
      },
    );
    expect(branches.stdout.trim()).toBe("");
  });

  it("creates and removes a session-scoped worktree", async () => {
    const repoPath = await makeRepo();
    const manager = new GitManager({
      repoPath,
      store: new InMemoryGitCheckpointStore(),
    });

    const worktree = await manager.createWorktree("session-1");
    tempDirs.push(worktree.worktreePath);

    expect(worktree.branch).toBe("iquantum/session-1");
    expect(worktree.worktreePath).toContain("session-1");
    await expect(
      readFile(join(worktree.worktreePath, "README.md"), "utf8"),
    ).resolves.toBe("initial\n");

    await manager.removeWorktree("session-1");

    const worktrees = await manager.listWorktrees();
    expect(
      worktrees.find((entry) => entry.worktreePath === worktree.worktreePath),
    ).toBeUndefined();
    const branches = await run(
      "git",
      ["branch", "--list", "iquantum/session-1"],
      {
        cwd: repoPath,
      },
    );
    expect(branches.stdout.trim()).toBe("");
  });

  it("ignores branch deletion only when the branch is already missing", async () => {
    const rawCalls: string[][] = [];
    const manager = new GitManager({
      repoPath: "/repo",
      store: new InMemoryGitCheckpointStore(),
      git: {
        async raw(args: string[]) {
          rawCalls.push(args);
          if (args[0] === "branch") {
            throw new Error("error: branch 'iquantum/session-1' not found.");
          }
          return "";
        },
      } as never,
    });

    await expect(
      manager.removeWorktree("/tmp/wt-session-1", "iquantum/session-1"),
    ).resolves.toBeUndefined();
    expect(rawCalls).toEqual([
      ["worktree", "remove", "--force", "/tmp/wt-session-1"],
      ["branch", "-D", "iquantum/session-1"],
    ]);
  });

  it("surfaces unexpected branch deletion errors", async () => {
    const manager = new GitManager({
      repoPath: "/repo",
      store: new InMemoryGitCheckpointStore(),
      git: {
        async raw(args: string[]) {
          if (args[0] === "branch") {
            throw new Error("fatal: unable to write loose object");
          }
          return "";
        },
      } as never,
    });

    await expect(
      manager.removeWorktree("/tmp/wt-session-1", "iquantum/session-1"),
    ).rejects.toThrow("unable to write loose object");
  });
});

async function makeRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "iquantum-git-"));
  tempDirs.push(repoPath);
  await run("git", ["init"], { cwd: repoPath });
  await run("git", ["config", "user.name", "Iquantum Test"], { cwd: repoPath });
  await run("git", ["config", "user.email", "test@iquantum.local"], {
    cwd: repoPath,
  });
  await writeFile(join(repoPath, "README.md"), "initial\n", "utf8");
  await run("git", ["add", "-A"], { cwd: repoPath });
  await run("git", ["commit", "-m", "initial"], { cwd: repoPath });
  return repoPath;
}
