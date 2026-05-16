import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  isDockerAvailable,
  loadTestCommand,
  SandboxExecTimeoutError,
  SandboxManager,
} from "./index";

const tempDirs: string[] = [];
const sessionIds: string[] = [];
const dockerAvailable = !process.env.CI && (await isDockerAvailable());

afterEach(async () => {
  const manager = new SandboxManager({ image: "alpine:3.20" });

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

describe("loadTestCommand", () => {
  it("prefers iquantum.config.json over package.json", async () => {
    const repoPath = await makeTempRepo();
    await writeRepoFile(
      repoPath,
      "iquantum.config.json",
      JSON.stringify({ testCommand: "bun test" }),
    );
    await writeRepoFile(
      repoPath,
      "package.json",
      JSON.stringify({ scripts: { test: "npm test" } }),
    );

    await expect(loadTestCommand(repoPath)).resolves.toBe("bun test");
  });

  it("falls back to package.json scripts.test", async () => {
    const repoPath = await makeTempRepo();
    await writeRepoFile(
      repoPath,
      "package.json",
      JSON.stringify({ scripts: { test: "bun test" } }),
    );

    await expect(loadTestCommand(repoPath)).resolves.toBe("bun run test");
  });
});

describe("SandboxManager exec timeout", () => {
  it("kills a hung container exec and rejects the exit code", async () => {
    const stream = new PassThrough();
    const killCalls: unknown[] = [];
    const container = {
      async inspect() {
        return {
          Config: {
            Labels: {
              "com.iquantum.repo-path": "/repo",
            },
          },
          State: { Running: true },
        };
      },
      async start() {
        return undefined;
      },
      async exec() {
        return {
          async start() {
            return stream;
          },
          async inspect() {
            return { ExitCode: 137 };
          },
        };
      },
      async kill(options: unknown) {
        killCalls.push(options);
      },
    };
    const manager = new SandboxManager({
      docker: {
        getContainer() {
          return container;
        },
        modem: {
          demuxStream() {
            return undefined;
          },
        },
      } as never,
      execTimeoutMs: 1,
    });

    await manager.resumeSandbox("session-1");
    const result = await manager.exec("session-1", "sleep forever");
    for await (const _chunk of result.output) {
      // timeout closes the output streams without yielding content
    }

    await expect(result.exitCode).rejects.toBeInstanceOf(
      SandboxExecTimeoutError,
    );
    expect(killCalls).toEqual([{ signal: "SIGKILL" }]);
  });
});

describe.skipIf(!dockerAvailable)("SandboxManager integration", () => {
  it("runs the configured repo test command inside the sandbox", async () => {
    const repoPath = await makeTempRepo();
    const sessionId = uniqueSessionId();
    const manager = new SandboxManager({ image: "alpine:3.20" });

    sessionIds.push(sessionId);
    await writeRepoFile(repoPath, "hello.txt", "from-host\n");
    await writeRepoFile(
      repoPath,
      "iquantum.config.json",
      JSON.stringify({ testCommand: "test -f hello.txt" }),
    );
    await manager.createSandbox(sessionId, repoPath);

    const command = await loadTestCommand(repoPath);
    const result = await collectExec(manager, sessionId, command ?? "false");

    expect(result.exitCode).toBe(0);
  });

  it("seeds an isolated volume and syncs validated changes back to the host", async () => {
    const repoPath = await makeTempRepo();
    const sessionId = uniqueSessionId();
    const manager = new SandboxManager({ image: "alpine:3.20" });

    sessionIds.push(sessionId);
    await writeRepoFile(repoPath, "hello.txt", "from-host\n");
    await manager.createSandbox(sessionId, repoPath);

    await collectExec(
      manager,
      sessionId,
      'cat hello.txt && printf "from-volume\\n" > hello.txt',
    );

    await expect(readText(join(repoPath, "hello.txt"))).resolves.toBe(
      "from-host\n",
    );

    await manager.syncToHost(sessionId);

    await expect(readText(join(repoPath, "hello.txt"))).resolves.toBe(
      "from-volume\n",
    );
    await expect(readText(join(repoPath, ".git/keep"))).resolves.toBe(
      "host git metadata",
    );
  });

  it("resumes an existing container and preserves volume state", async () => {
    const repoPath = await makeTempRepo();
    const sessionId = uniqueSessionId();
    const firstManager = new SandboxManager({ image: "alpine:3.20" });
    const secondManager = new SandboxManager({ image: "alpine:3.20" });

    sessionIds.push(sessionId);
    await writeRepoFile(repoPath, "hello.txt", "from-host\n");
    await firstManager.createSandbox(sessionId, repoPath);
    await collectExec(
      firstManager,
      sessionId,
      'printf "persisted\\n" > state.txt',
    );

    await secondManager.resumeSandbox(sessionId);
    const result = await collectExec(secondManager, sessionId, "cat state.txt");

    expect(result.stdout).toBe("persisted\n");
    expect(result.exitCode).toBe(0);
  });
});

async function makeTempRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "iquantum-sandbox-"));
  tempDirs.push(directory);
  await mkdir(join(directory, ".git"), { recursive: true });
  await writeRepoFile(directory, ".git/keep", "host git metadata");
  return directory;
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

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function uniqueSessionId(): string {
  return `test-${crypto.randomUUID()}`;
}

async function collectExec(
  manager: SandboxManager,
  sessionId: string,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await manager.exec(sessionId, command);
  let stdout = "";
  let stderr = "";

  for await (const chunk of result.output) {
    if (chunk.stream === "stdout") {
      stdout += chunk.data;
    } else {
      stderr += chunk.data;
    }
  }

  return {
    stdout,
    stderr,
    exitCode: await result.exitCode,
  };
}
