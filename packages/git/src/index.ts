import type { GitCheckpoint } from "@iquantum/types";
import { type SimpleGit, simpleGit } from "simple-git";

export interface GitCheckpointStore {
  insert(checkpoint: GitCheckpoint): Promise<void>;
  listBySession(sessionId: string): Promise<GitCheckpoint[]>;
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

  async listCheckpoints(sessionId: string): Promise<GitCheckpoint[]> {
    return this.#store.listBySession(sessionId);
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

  async listBySession(sessionId: string): Promise<GitCheckpoint[]> {
    return this.#checkpoints.filter(
      (checkpoint) => checkpoint.sessionId === sessionId,
    );
  }
}
