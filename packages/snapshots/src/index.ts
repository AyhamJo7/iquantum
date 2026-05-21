import { createHash } from "node:crypto";
import type { FileSnapshot } from "@iquantum/types";
import { createPatch } from "diff";

export interface FileDiff {
  filePath: string;
  patch: string;
}

export interface SnapshotTurn {
  turnIndex: number;
  fileCount: number;
  savedAt: string;
}

export interface SnapshotStorePort {
  save(snapshot: FileSnapshot): Promise<void>;
  restore(sessionId: string, turnIndex: number): Promise<FileSnapshot[]>;
  listTurns(sessionId: string): Promise<SnapshotTurn[]>;
  evict(sessionId: string, keepTurns: number): Promise<void>;
}

export interface SnapshotStoreOptions {
  store: SnapshotStorePort;
  now?: () => string;
  createId?: () => string;
}

export class SnapshotStore {
  readonly #store: SnapshotStorePort;
  readonly #now: () => string;
  readonly #createId: () => string;

  constructor(options: SnapshotStoreOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async save(
    sessionId: string,
    turnIndex: number,
    files: Map<string, string>,
  ): Promise<void> {
    const existing = new Map(
      (await this.#store.restore(sessionId, turnIndex)).map((snapshot) => [
        snapshot.filePath,
        snapshot.contentHash,
      ]),
    );
    const savedAt = this.#now();

    for (const [filePath, content] of files) {
      const contentHash = sha256(content);

      if (existing.get(filePath) === contentHash) {
        continue;
      }

      await this.#store.save({
        id: this.#createId(),
        sessionId,
        turnIndex,
        filePath,
        contentHash,
        content,
        savedAt,
      });
    }
  }

  async restore(
    sessionId: string,
    turnIndex: number,
  ): Promise<Map<string, string>> {
    return new Map(
      (await this.#store.restore(sessionId, turnIndex)).map((snapshot) => [
        snapshot.filePath,
        snapshot.content,
      ]),
    );
  }

  async diff(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
  ): Promise<FileDiff[]> {
    const from = await this.restore(sessionId, fromTurn);
    const to = await this.restore(sessionId, toTurn);
    const filePaths = new Set([...from.keys(), ...to.keys()]);

    return [...filePaths].sort().flatMap((filePath) => {
      const before = from.get(filePath) ?? "";
      const after = to.get(filePath) ?? "";

      if (before === after) {
        return [];
      }

      return [
        {
          filePath,
          patch: createPatch(filePath, before, after, "from", "to"),
        },
      ];
    });
  }

  listTurns(sessionId: string): Promise<SnapshotTurn[]> {
    return this.#store.listTurns(sessionId);
  }

  evict(sessionId: string, keepTurns: number): Promise<void> {
    return this.#store.evict(sessionId, keepTurns);
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
