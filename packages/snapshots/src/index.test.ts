import type { FileSnapshot } from "@iquantum/types";
import { describe, expect, it } from "vitest";
import { SnapshotStore } from "./index";

describe("SnapshotStore", () => {
  it("saves and restores a snapshot round-trip", async () => {
    const port = new MemorySnapshotPort();
    const store = snapshotStore(port);

    await store.save("session-1", 1, new Map([["src/a.ts", "hello\n"]]));

    await expect(store.restore("session-1", 1)).resolves.toEqual(
      new Map([["src/a.ts", "hello\n"]]),
    );
  });

  it("deduplicates unchanged files at the same turn", async () => {
    const port = new MemorySnapshotPort();
    const store = snapshotStore(port);

    await store.save("session-1", 1, new Map([["src/a.ts", "hello\n"]]));
    await store.save("session-1", 1, new Map([["src/a.ts", "hello\n"]]));

    expect(port.snapshots).toHaveLength(1);
  });

  it("evicts old turns", async () => {
    const port = new MemorySnapshotPort();
    const store = snapshotStore(port);

    await store.save("session-1", 1, new Map([["a", "1"]]));
    await store.save("session-1", 2, new Map([["a", "2"]]));
    await store.save("session-1", 3, new Map([["a", "3"]]));
    await store.evict("session-1", 2);

    expect(await store.listTurns("session-1")).toMatchObject([
      { turnIndex: 2 },
      { turnIndex: 3 },
    ]);
  });

  it("diffs changed files", async () => {
    const store = snapshotStore(new MemorySnapshotPort());

    await store.save("session-1", 1, new Map([["src/a.ts", "before\n"]]));
    await store.save("session-1", 2, new Map([["src/a.ts", "after\n"]]));

    const diff = await store.diff("session-1", 1, 2);

    expect(diff).toHaveLength(1);
    expect(diff[0]?.patch).toContain("-before");
    expect(diff[0]?.patch).toContain("+after");
  });

  it("returns an empty map for missing turns", async () => {
    const store = snapshotStore(new MemorySnapshotPort());

    await expect(store.restore("session-1", 99)).resolves.toEqual(new Map());
  });
});

function snapshotStore(port: MemorySnapshotPort): SnapshotStore {
  let nextId = 0;
  return new SnapshotStore({
    store: port,
    now: () => "2026-05-21T00:00:00.000Z",
    createId: () => `snapshot-${++nextId}`,
  });
}

class MemorySnapshotPort {
  readonly snapshots: FileSnapshot[] = [];

  async save(snapshot: FileSnapshot): Promise<void> {
    const index = this.snapshots.findIndex(
      (candidate) =>
        candidate.sessionId === snapshot.sessionId &&
        candidate.turnIndex === snapshot.turnIndex &&
        candidate.filePath === snapshot.filePath,
    );

    if (index === -1) {
      this.snapshots.push(snapshot);
    } else {
      this.snapshots[index] = snapshot;
    }
  }

  async restore(sessionId: string, turnIndex: number): Promise<FileSnapshot[]> {
    return this.snapshots.filter(
      (snapshot) =>
        snapshot.sessionId === sessionId && snapshot.turnIndex === turnIndex,
    );
  }

  async listTurns(sessionId: string) {
    const turns = new Map<number, FileSnapshot[]>();

    for (const snapshot of this.snapshots) {
      if (snapshot.sessionId !== sessionId) continue;
      turns.set(snapshot.turnIndex, [
        ...(turns.get(snapshot.turnIndex) ?? []),
        snapshot,
      ]);
    }

    return [...turns.entries()]
      .sort(([a], [b]) => a - b)
      .map(([turnIndex, snapshots]) => ({
        turnIndex,
        fileCount: snapshots.length,
        savedAt: snapshots.at(-1)?.savedAt ?? "",
      }));
  }

  async evict(sessionId: string, keepTurns: number): Promise<void> {
    const maxTurn = Math.max(
      -1,
      ...this.snapshots
        .filter((snapshot) => snapshot.sessionId === sessionId)
        .map((snapshot) => snapshot.turnIndex),
    );
    const threshold = maxTurn - keepTurns;

    for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.snapshots[index];

      if (
        snapshot?.sessionId === sessionId &&
        snapshot.turnIndex < threshold + 1
      ) {
        this.snapshots.splice(index, 1);
      }
    }
  }
}
