import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DiffEngine } from "@iquantum/diff-engine";
import { GitManager, InMemoryGitCheckpointStore } from "@iquantum/git";
import { isDockerAvailable, SandboxManager } from "@iquantum/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryPIVStore, PIVEngine } from "./index";

const run = promisify(execFile);
const dockerAvailable = await isDockerAvailable();
const tempDirs: string[] = [];
const sessionIds: string[] = [];

afterEach(async () => {
  const manager = new SandboxManager();

  await Promise.all(
    sessionIds.splice(0).map(async (sessionId) => {
      await manager.destroySandbox(sessionId);
    }),
  );
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe.skipIf(!dockerAvailable || Boolean(process.env.CI))(
  "PIVEngine integration",
  () => {
    it("completes a real plan-to-checkpoint cycle in an isolated sandbox", async () => {
      const repoPath = await makeRepo();
      const sessionId = `piv-${crypto.randomUUID()}`;
      const sandbox = new SandboxManager();
      const checkpoints = new InMemoryGitCheckpointStore();
      const completions = [
        "Update answer() so the test expects 42.",
        [
          "--- a/src/value.ts",
          "+++ b/src/value.ts",
          "@@ -1,3 +1,3 @@",
          " export function answer(): number {",
          "-  return 41;",
          "+  return 42;",
          " }",
        ].join("\n"),
      ];

      sessionIds.push(sessionId);
      await sandbox.createSandbox(sessionId, repoPath);

      const engine = new PIVEngine({
        sessionId,
        repoPath,
        testCommand: "bun test",
        store: new InMemoryPIVStore(),
        llmRouter: {
          async *complete() {
            yield completions.shift() ?? "";
          },
        },
        diffEngine: new DiffEngine(sandbox),
        sandbox,
        gitManager: new GitManager({ repoPath, store: checkpoints }),
      });

      const plan = await engine.startTask("Make answer() return 42");
      await engine.approve(plan.id);

      await expect(readFile(join(repoPath, "PLAN.md"), "utf8")).resolves.toBe(
        "Update answer() so the test expects 42.",
      );
      await expect(
        readFile(join(repoPath, "src/value.ts"), "utf8"),
      ).resolves.toContain("return 42;");
      await expect(checkpoints.listBySession(sessionId)).resolves.toHaveLength(
        1,
      );
      expect(engine.status).toBe("completed");
    }, 60_000);
  },
);

async function makeRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "iquantum-piv-"));
  tempDirs.push(repoPath);
  await run("git", ["init"], { cwd: repoPath });
  await run("git", ["config", "user.name", "Iquantum Test"], {
    cwd: repoPath,
  });
  await run("git", ["config", "user.email", "test@iquantum.local"], {
    cwd: repoPath,
  });
  await writeRepoFile(
    repoPath,
    "package.json",
    JSON.stringify({ type: "module", scripts: { test: "bun test" } }),
  );
  await writeRepoFile(
    repoPath,
    "src/value.ts",
    ["export function answer(): number {", "  return 41;", "}", ""].join("\n"),
  );
  await writeRepoFile(
    repoPath,
    "src/value.test.ts",
    [
      'import { expect, test } from "bun:test";',
      'import { answer } from "./value";',
      "",
      'test("answer", () => {',
      "  expect(answer()).toBe(42);",
      "});",
      "",
    ].join("\n"),
  );
  await run("git", ["add", "-A"], { cwd: repoPath });
  await run("git", ["commit", "-m", "initial"], { cwd: repoPath });
  return repoPath;
}

async function writeRepoFile(
  repoPath: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const filePath = join(repoPath, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
