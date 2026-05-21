import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory } from "@iquantum/types";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryManager, type MemoryStoreInterface } from "./manager";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("MemoryManager", () => {
  it("buildBlock respects the token budget", async () => {
    const manager = createManager({
      memories: [
        memory("first", "a".repeat(40), "2026-05-16T00:00:00.000Z"),
        memory("second", "b".repeat(40), "2026-05-15T00:00:00.000Z"),
        memory("third", "c".repeat(40), "2026-05-14T00:00:00.000Z"),
      ],
      budgetTokens: 100,
      countTokens: () => 40,
    });

    const block = await manager.buildBlock("user-1", null);

    expect(block.text).toContain("### first");
    expect(block.text).toContain("### second");
    expect(block.text).not.toContain("### third");
  });

  it("buildBlock includes pinned memory first even if it exceeds budget", async () => {
    const manager = createManager({
      memories: [
        memory("recent", "recent", "2026-05-17T00:00:00.000Z"),
        memory("pinned", "pinned".repeat(20), "2026-05-14T00:00:00.000Z", {
          pinned: true,
        }),
      ],
      budgetTokens: 10,
      countTokens: (text) => text.length,
    });

    const block = await manager.buildBlock("user-1", null);

    expect(block.text.startsWith("### pinned")).toBe(true);
    expect(block.text).not.toContain("### recent");
  });

  it("materialize writes MEMORY.md frontmatter", async () => {
    const memoriesDir = await tempDir();
    const manager = createManager({
      memories: [memory("bun-project", "Use Bun.", "2026-05-16T00:00:00.000Z")],
      memoriesDir,
    });

    await manager.materialize("user-1", null);

    const content = await readFile(join(memoriesDir, "MEMORY.md"), "utf8");
    expect(content).toContain("---\n");
    expect(content).toContain("name: bun-project\n");
    expect(content).toContain("type: project\n");
    expect(content).toContain("description: Test memory\n");
    expect(content).toContain("Use Bun.");
  });

  it("syncFromFile upserts parsed memories", async () => {
    const memoriesDir = await tempDir();
    const filePath = join(memoriesDir, "MEMORY.md");
    const store = fakeStore([]);
    const manager = new MemoryManager(
      {
        store,
        countTokens: (text) => text.length,
        now: () => "2026-05-19T00:00:00.000Z",
        createId: () => "generated-id",
      },
      { budgetTokens: 1000, memoriesDir },
    );
    await writeFile(
      filePath,
      [
        "---",
        "name: first",
        "type: project",
        "description: One",
        "---",
        "First body",
        "",
        "---",
        "name: second",
        "type: reference",
        "description: Two",
        "pinned: true",
        "---",
        "Second body",
      ].join("\n"),
      "utf8",
    );

    await expect(
      manager.syncFromFile(filePath, "user-1", "org-1"),
    ).resolves.toBe(2);
    expect(store.upserts).toMatchObject([
      { name: "first", body: "First body", type: "project" },
      { name: "second", body: "Second body", type: "reference", pinned: true },
    ]);
  });

  it("syncFromFile preserves body text containing ---", async () => {
    const memoriesDir = await tempDir();
    const filePath = join(memoriesDir, "MEMORY.md");
    const store = fakeStore([]);
    const manager = new MemoryManager(
      { store, countTokens: (text) => text.length },
      { budgetTokens: 1000, memoriesDir },
    );
    await writeFile(
      filePath,
      [
        "---",
        "name: with-separator",
        "type: project",
        "description: Has a rule",
        "---",
        "Line one",
        "",
        "---",
        "Line after separator",
        "",
        "---",
        "name: next-entry",
        "type: project",
        "description: Next",
        "---",
        "Next body",
      ].join("\n"),
      "utf8",
    );

    await manager.syncFromFile(filePath, "user-1", null);

    expect(store.upserts[0]?.body).toBe(
      "Line one\n\n---\nLine after separator",
    );
    expect(store.upserts[1]?.name).toBe("next-entry");
  });

  it("syncFromFile skips malformed blocks", async () => {
    const memoriesDir = await tempDir();
    const filePath = join(memoriesDir, "MEMORY.md");
    const store = fakeStore([]);
    const manager = new MemoryManager(
      { store, countTokens: (text) => text.length },
      { budgetTokens: 1000, memoriesDir },
    );
    await writeFile(
      filePath,
      [
        "---",
        "type: project",
        "description: Missing name",
        "---",
        "Skipped",
        "",
        "---",
        "name: valid",
        "type: project",
        "description: Valid",
        "---",
        "Kept",
      ].join("\n"),
      "utf8",
    );

    await expect(manager.syncFromFile(filePath, "user-1", null)).resolves.toBe(
      1,
    );
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0]?.name).toBe("valid");
  });
});

function createManager(options: {
  memories: Memory[];
  budgetTokens?: number;
  memoriesDir?: string;
  countTokens?: (text: string) => number;
}): MemoryManager {
  return new MemoryManager(
    {
      store: fakeStore(options.memories),
      countTokens: options.countTokens ?? ((text) => text.length),
    },
    {
      budgetTokens: options.budgetTokens ?? 1000,
      memoriesDir: options.memoriesDir ?? "/tmp/iquantum-memory-test",
    },
  );
}

function fakeStore(memories: Memory[]): MemoryStoreInterface & {
  upserts: Memory[];
} {
  const upserts: Memory[] = [];
  return {
    upserts,
    async insert() {
      return undefined;
    },
    async get() {
      return null;
    },
    async listByUser() {
      return memories;
    },
    async update() {
      return null;
    },
    async upsertByName(memory) {
      upserts.push(memory);
      return memory;
    },
    async delete() {
      return undefined;
    },
  };
}

function memory(
  name: string,
  body: string,
  updatedAt: string,
  options: { pinned?: boolean } = {},
): Memory {
  return {
    id: `${name}-id`,
    userId: "user-1",
    orgId: null,
    type: "project",
    scope: "user",
    source: "manual",
    name,
    description: "Test memory",
    body,
    pinned: options.pinned ?? false,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iquantum-memory-"));
  tmpDirs.push(dir);
  return dir;
}
