import type { SnapshotStore } from "@iquantum/snapshots";

export interface SnapshotSandbox {
  exec(sessionId: string, command: string): Promise<unknown>;
}

export class SnapshotController {
  readonly #store: SnapshotStore;
  readonly #sandbox: SnapshotSandbox;

  constructor(options: { store: SnapshotStore; sandbox: SnapshotSandbox }) {
    this.#store = options.store;
    this.#sandbox = options.sandbox;
  }

  listTurns(sessionId: string) {
    return this.#store.listTurns(sessionId);
  }

  restore(sessionId: string, turnIndex: number) {
    return this.#store.restore(sessionId, turnIndex);
  }

  diff(sessionId: string, fromTurn: number, toTurn: number) {
    return this.#store.diff(sessionId, fromTurn, toTurn);
  }

  evict(sessionId: string, keepTurns: number) {
    return this.#store.evict(sessionId, keepTurns);
  }

  async saveFilesFromSandbox(
    sessionId: string,
    turnIndex: number,
    filePaths: readonly string[],
  ): Promise<void> {
    const files = new Map<string, string>();
    for (const filePath of uniqueSafePaths(filePaths)) {
      const result = await this.#sandbox.exec(
        sessionId,
        `if [ -f ${sh(filePath)} ]; then base64 -w0 ${sh(filePath)}; fi`,
      );
      const stdout = execStdout(result).trim();
      if (stdout) {
        files.set(filePath, Buffer.from(stdout, "base64").toString("utf8"));
      }
    }

    if (files.size > 0) {
      await this.#store.save(sessionId, turnIndex, files);
    }
  }

  async restoreToSandbox(sessionId: string, turnIndex: number): Promise<void> {
    const files = await this.#store.restore(sessionId, turnIndex);
    for (const [filePath, content] of files) {
      const encoded = Buffer.from(content, "utf8").toString("base64");
      await this.#sandbox.exec(
        sessionId,
        [
          `mkdir -p "$(dirname -- ${sh(filePath)})"`,
          `printf %s ${sh(encoded)} | base64 -d > ${sh(filePath)}`,
        ].join(" && "),
      );
    }
  }
}

function execStdout(result: unknown): string {
  if (typeof result === "object" && result !== null && "stdout" in result) {
    const stdout = (result as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
  return "";
}

function uniqueSafePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(isSafeRelativePath))];
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => part === ".." || part === "")
  );
}

function sh(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
