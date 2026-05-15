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
    await expect(manager.listCheckpoints("session-1")).resolves.toEqual([
      checkpoint,
    ]);

    await writeFile(join(repoPath, "README.md"), "dirty\n", "utf8");
    await manager.restore(checkpoint.commitHash);

    await expect(readFile(join(repoPath, "README.md"), "utf8")).resolves.toBe(
      "changed\n",
    );
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
