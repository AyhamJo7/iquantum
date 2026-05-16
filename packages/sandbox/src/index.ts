import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import Docker from "dockerode";

const workspacePath = "/workspace";
const repoPathLabel = "com.iquantum.repo-path";
const sessionIdLabel = "com.iquantum.session-id";

export const DEFAULT_SANDBOX_IMAGE = "ghcr.io/ayhamjo7/iquantum-sandbox:latest";

export interface SandboxManagerOptions {
  docker?: Docker;
  /** Sandbox container image. Defaults to the GHCR release image. */
  image?: string;
  seedImage?: string;
  execTimeoutMs?: number;
}

export interface SandboxInfo {
  sessionId: string;
  containerName: string;
  volumeName: string;
  repoPath: string;
}

export interface ExecChunk {
  stream: "stdout" | "stderr";
  data: string;
}

// exitCode only resolves after output has been fully consumed.
// Always drain output before awaiting exitCode to avoid a deadlock.
export interface ExecResult {
  output: AsyncIterable<ExecChunk>;
  exitCode: Promise<number>;
}

export class SandboxExecTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Sandbox exec timed out after ${timeoutMs}ms`);
    this.name = "SandboxExecTimeoutError";
  }
}

export class SandboxManager {
  readonly #docker: Docker;
  readonly #image: string;
  readonly #seedImage: string;
  readonly #execTimeoutMs: number;
  readonly #sandboxes = new Map<string, SandboxInfo>();
  #imageReady = false;

  constructor(options: SandboxManagerOptions = {}) {
    this.#docker = options.docker ?? new Docker();
    this.#image = options.image ?? DEFAULT_SANDBOX_IMAGE;
    this.#seedImage = options.seedImage ?? "alpine:3.20";
    this.#execTimeoutMs = options.execTimeoutMs ?? 120_000;

    if (!Number.isFinite(this.#execTimeoutMs) || this.#execTimeoutMs <= 0) {
      throw new Error("execTimeoutMs must be a positive finite number");
    }
  }

  /**
   * Ensures the sandbox image is present locally, pulling from the registry
   * if needed. Safe to call multiple times — pulls only on the first call per
   * process. Invoke once at daemon startup for early feedback before any
   * session is created.
   */
  async ensureImageReady(
    log: (msg: string) => void = () => undefined,
  ): Promise<void> {
    if (this.#imageReady) return;
    const already = await this.#imageExists(this.#image);
    if (!already) {
      log(`pulling sandbox image ${this.#image}…`);
    }
    await this.#ensureImage(this.#image);
    this.#imageReady = true;
    if (!already) {
      log(`sandbox image ready`);
    }
  }

  async createSandbox(
    sessionId: string,
    repoPath: string,
  ): Promise<SandboxInfo> {
    const normalizedRepoPath = resolve(repoPath);
    const info = sandboxInfo(sessionId, normalizedRepoPath);

    await this.#ensureImage(this.#seedImage);
    // ensureImageReady() is the preferred startup path; this guards against
    // createSandbox being called before ensureImageReady().
    if (!this.#imageReady) {
      await this.#ensureImage(this.#image);
      this.#imageReady = true;
    }
    await this.#docker.createVolume({ Name: info.volumeName });
    await this.#seedVolume(info);

    const container = await this.#docker.createContainer({
      name: info.containerName,
      Image: this.#image,
      Cmd: ["sh", "-lc", "tail -f /dev/null"],
      WorkingDir: workspacePath,
      Labels: {
        [repoPathLabel]: normalizedRepoPath,
        [sessionIdLabel]: sessionId,
      },
      HostConfig: {
        Binds: [`${info.volumeName}:${workspacePath}`],
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });

    await container.start();

    // Install dependencies inside the container. node_modules is excluded from
    // the seed copy because Bun's .bun/ registry is host-specific. Skip when
    // bun is not available (e.g. lightweight test images without bun).
    await this.#runInContainer(
      info.containerName,
      "command -v bun >/dev/null 2>&1 && { [ -f bun.lockb ] || [ -f bun.lock ]; } && bun install --frozen-lockfile || true",
    );

    this.#sandboxes.set(sessionId, info);
    return info;
  }

  async resumeSandbox(sessionId: string): Promise<SandboxInfo> {
    const container = this.#docker.getContainer(containerName(sessionId));
    const inspection = await container.inspect();
    const repoPath = inspection.Config.Labels?.[repoPathLabel];

    if (!repoPath) {
      throw new Error(`Sandbox ${sessionId} is missing ${repoPathLabel}`);
    }

    if (!inspection.State.Running) {
      await container.start();
    }

    const info = sandboxInfo(sessionId, repoPath);
    this.#sandboxes.set(sessionId, info);
    return info;
  }

  async exec(sessionId: string, command: string): Promise<ExecResult> {
    const container = await this.#getContainer(sessionId);
    const exec = await container.exec({
      Cmd: ["sh", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: workspacePath,
    });
    const stream = await exec.start({ Detach: false, stdin: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    this.#docker.modem.demuxStream(stream, stdout, stderr);
    stream.once("end", () => {
      stdout.end();
      stderr.end();
    });
    stream.once("close", () => {
      stdout.end();
      stderr.end();
    });

    const streamClosed = onceClosed(stream);
    const timeoutError = new SandboxExecTimeoutError(this.#execTimeoutMs);
    let timeout: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(timeoutError);

        void container.kill({ signal: "SIGKILL" }).catch((error) => {
          if (!isDockerNotFound(error)) {
            // The timeout remains the user-facing failure; a concurrent
            // container exit should not mask it.
          }
        });

        stream.destroy();
        stdout.end();
        stderr.end();
      }, this.#execTimeoutMs);
    });
    const exitCode = Promise.race([
      streamClosed.then(async () => {
        const inspection = await exec.inspect();
        return inspection.ExitCode ?? 0;
      }),
      timedOut,
    ]).finally(() => clearTimeout(timeout));

    return {
      output: mergeOutput(stdout, stderr),
      exitCode,
    };
  }

  // docker cp copies and overwrites but does not mirror deletions.
  // If DiffEngine gains delete support, replace this with a mirror step.
  async #runInContainer(containerName: string, command: string): Promise<void> {
    const container = this.#docker.getContainer(containerName);
    const exec = await container.exec({
      Cmd: ["sh", "-lc", command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: workspacePath,
    });
    const stream = await exec.start({ Detach: false, stdin: false });
    // Drain the stream so the exec can complete.
    stream.resume();
    await onceClosed(stream);
    const inspection = await exec.inspect();

    if ((inspection.ExitCode ?? 0) !== 0) {
      throw new Error(
        `Container command failed (exit ${inspection.ExitCode ?? "?"}): ${command}`,
      );
    }
  }

  async syncToHost(sessionId: string): Promise<void> {
    const info = await this.#getSandboxInfo(sessionId);

    await runCommand([
      "docker",
      "cp",
      `${info.containerName}:${workspacePath}/.`,
      info.repoPath,
    ]);
  }

  async destroySandbox(sessionId: string): Promise<void> {
    const info = await this.#getSandboxInfo(sessionId);
    const container = this.#docker.getContainer(info.containerName);

    try {
      await container.remove({ force: true });
    } catch (error) {
      if (!isDockerNotFound(error)) {
        throw error;
      }
    }

    try {
      await this.#docker.getVolume(info.volumeName).remove();
    } catch (error) {
      if (!isDockerNotFound(error)) {
        throw error;
      }
    }

    this.#sandboxes.delete(sessionId);
  }

  async #seedVolume(info: SandboxInfo): Promise<void> {
    // Exclude node_modules: Bun's .bun/ registry format is host-specific and
    // will not resolve correctly inside the container. The main container runs
    // `bun install` after seeding to build a clean, container-native install.
    const seedContainer = await this.#docker.createContainer({
      Image: this.#seedImage,
      Cmd: [
        "sh",
        "-lc",
        "cp -a /host/. /workspace/ && rm -rf /workspace/.git /workspace/node_modules",
      ],
      HostConfig: {
        Binds: [
          `${info.repoPath}:/host:ro`,
          `${info.volumeName}:${workspacePath}`,
        ],
      },
    });

    try {
      await seedContainer.start();
      const result = await seedContainer.wait();

      if (result.StatusCode !== 0) {
        throw new Error(`Failed to seed sandbox volume for ${info.sessionId}`);
      }
    } finally {
      await seedContainer.remove({ force: true });
    }
  }

  async #imageExists(image: string): Promise<boolean> {
    try {
      await this.#docker.getImage(image).inspect();
      return true;
    } catch (error) {
      if (isDockerNotFound(error)) return false;
      throw error;
    }
  }

  async #ensureImage(image: string): Promise<void> {
    if (await this.#imageExists(image)) return;

    const stream = await this.#docker.pull(image);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#docker.modem.followProgress(stream, (progressError) => {
        if (progressError) {
          rejectPromise(progressError);
          return;
        }
        resolvePromise();
      });
    });
  }

  async #getContainer(sessionId: string): Promise<Docker.Container> {
    const info = await this.#getSandboxInfo(sessionId);
    const container = this.#docker.getContainer(info.containerName);
    const inspection = await container.inspect();

    if (!inspection.State.Running) {
      await container.start();
    }

    return container;
  }

  async #getSandboxInfo(sessionId: string): Promise<SandboxInfo> {
    return this.#sandboxes.get(sessionId) ?? this.resumeSandbox(sessionId);
  }
}

export async function loadTestCommand(
  repoPath: string,
): Promise<string | undefined> {
  const config = await readJson(join(repoPath, "iquantum.config.json"));

  if (isStringRecord(config) && typeof config.testCommand === "string") {
    return config.testCommand;
  }

  const packageJson = await readJson(join(repoPath, "package.json"));

  if (
    isStringRecord(packageJson) &&
    isStringRecord(packageJson.scripts) &&
    typeof packageJson.scripts.test === "string"
  ) {
    // Run through bun so the sandbox's node_modules/.bin is on PATH.
    return "bun run test";
  }

  return undefined;
}

export async function isDockerAvailable(
  docker = new Docker(),
): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

export async function isSandboxImageAvailable(
  image: string,
  docker = new Docker(),
): Promise<boolean> {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

function sandboxInfo(sessionId: string, repoPath: string): SandboxInfo {
  return {
    sessionId,
    containerName: containerName(sessionId),
    volumeName: volumeName(sessionId),
    repoPath,
  };
}

function containerName(sessionId: string): string {
  return `iquantum-${sessionId}`;
}

function volumeName(sessionId: string): string {
  return `iquantum-vol-${sessionId}`;
}

async function* mergeOutput(
  stdout: Readable,
  stderr: Readable,
): AsyncIterable<ExecChunk> {
  const iterator = mergeIterators([
    toChunks(stdout, "stdout"),
    toChunks(stderr, "stderr"),
  ]);

  for await (const chunk of iterator) {
    yield chunk;
  }
}

async function* toChunks(
  stream: Readable,
  streamName: ExecChunk["stream"],
): AsyncIterable<ExecChunk> {
  for await (const chunk of stream) {
    yield {
      stream: streamName,
      data: Buffer.from(chunk).toString("utf8"),
    };
  }
}

async function* mergeIterators<T>(
  iterables: AsyncIterable<T>[],
): AsyncIterable<T> {
  const iterators = iterables.map((iterable) =>
    iterable[Symbol.asyncIterator](),
  );
  const pending = new Map(
    iterators.map((iterator, index) => [index, iterator.next()] as const),
  );

  while (pending.size > 0) {
    const { index, result } = await Promise.race(
      [...pending.entries()].map(async ([index, promise]) => ({
        index,
        result: await promise,
      })),
    );

    if (result.done) {
      pending.delete(index);
      continue;
    }

    yield result.value;
    pending.set(
      index,
      iterators[index]?.next() ??
        Promise.resolve({ done: true, value: undefined }),
    );
  }
}

async function onceClosed(stream: NodeJS.ReadableStream): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    stream.once("end", resolvePromise);
    stream.once("close", resolvePromise);
    stream.once("error", rejectPromise);
  });
}

async function runCommand(command: string[]): Promise<void> {
  const [executable, ...args] = command;

  if (!executable) {
    throw new Error("Cannot run an empty command");
  }

  const child = spawn(executable, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>(
    (resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code) => resolvePromise(code ?? 1));
    },
  );

  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDockerNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  );
}
