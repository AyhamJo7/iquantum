import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { IquantumConfig } from "@iquantum/config";
import {
  type ExecResult,
  SandboxManager as LocalSandboxManager,
  type SandboxInfo,
  type SandboxRuntime,
} from "@iquantum/sandbox";
import { CloudSandboxManager } from "./cloud-sandbox-manager";

export interface SessionSandboxManager {
  createSandbox(sessionId: string, repoPath: string): Promise<SandboxInfo>;
  destroySandbox(sessionId: string): Promise<void>;
  exec(sessionId: string, command: string): Promise<ExecResult>;
  syncToHost(sessionId: string): Promise<void>;
}

export function createSandboxManager(
  config: IquantumConfig,
): SessionSandboxManager {
  if (!config.cloud) {
    return new LocalSandboxManager({
      execTimeoutMs: config.execTimeoutMs,
      image: config.sandboxImage,
    });
  }

  return new CloudSandboxSessionAdapter(createSandboxRuntime(config));
}

export function createSandboxRuntime(config: IquantumConfig): SandboxRuntime {
  if (!config.cloud) {
    return new LocalSandboxManager({
      execTimeoutMs: config.execTimeoutMs,
      image: config.sandboxImage,
    });
  }

  return new CloudSandboxManager({
    region: config.awsRegion ?? "us-east-1",
    cluster: config.awsEcsCluster ?? "iquantum",
    efsFileSystemId: config.awsEfsFileSystemId ?? "",
    taskDefinition: "iquantum-sandbox",
    subnetIds: config.awsSubnetIds ?? [],
    securityGroupIds: config.awsSecurityGroupIds ?? [],
    assignPublicIp: config.awsAssignPublicIp,
    execTimeoutMs: config.execTimeoutMs,
  });
}

/**
 * SessionController still uses the v1 lifecycle shape because the PIV loop
 * checkpoints host-side Git after validation. Cloud sandboxes expose the newer
 * start/stop runtime shape, so this adapter uses the shared EFS mount as the
 * same seed/sync surface the local Docker manager provides with named volumes.
 */
export class CloudSandboxSessionAdapter implements SessionSandboxManager {
  readonly #sessions = new Map<
    string,
    { repoPath: string; workspacePath: string }
  >();

  constructor(private readonly runtime: SandboxRuntime) {}

  async createSandbox(
    sessionId: string,
    repoPath: string,
  ): Promise<SandboxInfo> {
    const workspacePath = this.runtime.volumePath(sessionId);
    await mkdir(dirname(workspacePath), { recursive: true });
    await rm(workspacePath, { recursive: true, force: true });
    await cp(repoPath, workspacePath, {
      recursive: true,
      filter: (source) => shouldCopyIntoSandbox(repoPath, source),
    });

    try {
      const { containerId, volumeId } = await this.runtime.start(sessionId);
      this.#sessions.set(sessionId, { repoPath, workspacePath });
      return {
        sessionId,
        repoPath,
        containerName: containerId,
        volumeName: volumeId,
      };
    } catch (error) {
      await rm(workspacePath, { recursive: true, force: true });
      throw error;
    }
  }

  async destroySandbox(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    await this.runtime.stop(sessionId);
    if (session) {
      await rm(session.workspacePath, { recursive: true, force: true });
      this.#sessions.delete(sessionId);
    }
  }

  exec(sessionId: string, command: string): Promise<ExecResult> {
    return this.runtime.exec(sessionId, command);
  }

  async syncToHost(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown cloud sandbox session ${sessionId}`);
    }

    for (const entry of await readdir(session.workspacePath)) {
      await cp(
        join(session.workspacePath, entry),
        join(session.repoPath, entry),
        {
          recursive: true,
          force: true,
        },
      );
    }
  }
}

function shouldCopyIntoSandbox(repoPath: string, source: string): boolean {
  const pathFromRepoRoot = relative(repoPath, source);
  if (!pathFromRepoRoot) return true;

  return !pathFromRepoRoot
    .split(sep)
    .some((part) => part === ".git" || part === "node_modules");
}
