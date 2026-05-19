import type { GitCheckpoint } from "@iquantum/types";
import { type SimpleGit, simpleGit } from "simple-git";

export interface GitCheckpointStore {
  insert(checkpoint: GitCheckpoint): Promise<void>;
  listBySession(
    sessionId: string,
    options?: { before?: string; limit: number },
  ): Promise<GitCheckpointPage>;
}

export interface GitCheckpointPage {
  checkpoints: GitCheckpoint[];
  nextCursor: string | null;
}

export interface GitManagerOptions {
  repoPath: string;
  store: GitCheckpointStore;
  git?: SimpleGit;
  now?: () => string;
  createId?: () => string;
}

export class GitManager {
  readonly #git: SimpleGit;
  readonly #store: GitCheckpointStore;
  readonly #now: () => string;
  readonly #createId: () => string;

  constructor(options: GitManagerOptions) {
    this.#git = options.git ?? simpleGit(options.repoPath);
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async checkpoint(
    sessionId: string,
    message: string,
    validateRunId: string,
  ): Promise<GitCheckpoint> {
    await this.#git.add(["-A"]);
    await this.#git.commit(message);
    const commitHash = (await this.#git.revparse(["HEAD"])).trim();
    const checkpoint: GitCheckpoint = {
      id: this.#createId(),
      sessionId,
      validateRunId,
      commitHash,
      commitMessage: message,
      createdAt: this.#now(),
    };

    await this.#store.insert(checkpoint);
    return checkpoint;
  }

  async listCheckpoints(
    sessionId: string,
    options: { before?: string; limit: number } = { limit: 50 },
  ): Promise<GitCheckpointPage> {
    return this.#store.listBySession(sessionId, options);
  }

  async restore(hash: string): Promise<void> {
    await this.#git.reset(["--hard", hash]);
  }
}

export class InMemoryGitCheckpointStore implements GitCheckpointStore {
  readonly #checkpoints: GitCheckpoint[] = [];

  async insert(checkpoint: GitCheckpoint): Promise<void> {
    this.#checkpoints.push(checkpoint);
  }

  async listBySession(
    sessionId: string,
    options: { before?: string; limit: number } = { limit: 50 },
  ): Promise<GitCheckpointPage> {
    let checkpoints = this.#checkpoints
      .filter((checkpoint) => checkpoint.sessionId === sessionId)
      .sort(compareCheckpoints);
    if (options.before) {
      const cursor = checkpoints.findIndex(
        (checkpoint) => checkpoint.id === options.before,
      );
      checkpoints = cursor === -1 ? [] : checkpoints.slice(cursor + 1);
    }
    const page = checkpoints.slice(0, options.limit);
    return {
      checkpoints: page,
      nextCursor:
        checkpoints.length > options.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}

function compareCheckpoints(left: GitCheckpoint, right: GitCheckpoint): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
