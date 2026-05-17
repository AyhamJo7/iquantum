import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, SandboxRuntime } from "@iquantum/sandbox";
import { describe, expect, it } from "vitest";
import { CloudSandboxSessionAdapter } from "./sandbox-factory";

describe("CloudSandboxSessionAdapter", () => {
  it("bridges the cloud runtime into the session-controller sandbox contract", async () => {
    const root = join(
      tmpdir(),
      `iquantum-cloud-adapter-${crypto.randomUUID()}`,
    );
    const repoPath = join(root, "repo");
    const volumeRoot = join(root, "volumes");
    await mkdir(join(repoPath, ".git"), { recursive: true });
    await mkdir(join(repoPath, "node_modules"), { recursive: true });
    await writeFile(join(repoPath, "tracked.txt"), "before");
    await writeFile(join(repoPath, ".git", "config"), "git");
    await writeFile(join(repoPath, "node_modules", "pkg"), "pkg");

    const runtime = new FakeCloudRuntime(volumeRoot);
    const adapter = new CloudSandboxSessionAdapter(runtime);
    const info = await adapter.createSandbox("session-1", repoPath);
    const workspacePath = runtime.volumePath("session-1");

    expect(info).toMatchObject({
      containerName: "task-session-1",
      volumeName: "volume-session-1",
    });
    await expect(
      readFile(join(workspacePath, "tracked.txt"), "utf8"),
    ).resolves.toBe("before");
    await expect(
      readFile(join(workspacePath, ".git", "config")),
    ).rejects.toThrow();
    await expect(
      readFile(join(workspacePath, "node_modules", "pkg")),
    ).rejects.toThrow();

    await writeFile(join(workspacePath, "tracked.txt"), "after");
    await adapter.syncToHost("session-1");
    await expect(readFile(join(repoPath, "tracked.txt"), "utf8")).resolves.toBe(
      "after",
    );

    await adapter.destroySandbox("session-1");
    expect(runtime.stopped).toEqual(["session-1"]);
  });
});

class FakeCloudRuntime implements SandboxRuntime {
  readonly stopped: string[] = [];

  constructor(private readonly volumeRoot: string) {}

  async start(
    sessionId: string,
  ): Promise<{ containerId: string; volumeId: string }> {
    return {
      containerId: `task-${sessionId}`,
      volumeId: `volume-${sessionId}`,
    };
  }

  async exec(_sessionId: string, _command: string): Promise<ExecResult> {
    return {
      output: (async function* () {})(),
      exitCode: Promise.resolve(0),
    };
  }

  async stop(sessionId: string): Promise<void> {
    this.stopped.push(sessionId);
  }

  async isRunning(_sessionId: string): Promise<boolean> {
    return true;
  }

  volumePath(sessionId: string): string {
    return join(this.volumeRoot, sessionId);
  }
}
