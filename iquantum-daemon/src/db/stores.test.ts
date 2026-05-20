import { describe, expect, it } from "vitest";
import type { DbAdapter } from "./adapter";
import {
  AdapterConversationStore,
  AdapterMemoryStore,
  SqliteHookRunStore,
  SqliteMemoryStore,
  SqliteSessionStore,
} from "./stores";

describe("SqliteSessionStore.update", () => {
  it("runs UPDATE with correct params then re-fetches the session", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const fakeRow = {
      id: "session-1",
      status: "idle",
      repoPath: "/repo",
      containerId: "c-1",
      volumeId: "v-1",
      config: "{}",
      mode: "piv",
      effort: "fast",
      worktreePath: null,
      worktreeBranch: null,
      startCheckpointHash: null,
      userId: null,
      orgId: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
    };
    const store = new SqliteSessionStore({
      query(sql: string) {
        return {
          run(...params: unknown[]) {
            statements.push({ sql, params });
          },
          get() {
            return fakeRow;
          },
        };
      },
    } as never);

    const updated = await store.update("session-1", { effort: "fast" });

    const updateStmt = statements.find((s) =>
      s.sql.includes("UPDATE sessions"),
    );
    expect(updateStmt?.sql).toContain("effort = ?");
    expect(updateStmt?.params).toContain("fast");
    expect(updateStmt?.params).toContain("session-1");
    expect(updated.effort).toBe("fast");
  });

  it("throws when the session row is not found after update", async () => {
    const store = new SqliteSessionStore({
      query() {
        return {
          run() {},
          get() {
            return null;
          },
        };
      },
    } as never);

    await expect(store.update("missing", { effort: "fast" })).rejects.toThrow(
      "Unknown session",
    );
  });
});

describe("SqliteSessionStore.getContextStats", () => {
  it("sums token_count and identifies last-turn tokens via the subquery", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const store = new SqliteSessionStore({
      query(sql: string) {
        return {
          get(...params: unknown[]) {
            capturedSql = sql;
            capturedParams = params;
            return { total: 350, lastTurn: 250 };
          },
        };
      },
    } as never);

    const stats = await store.getContextStats("session-1");

    expect(capturedSql).toContain("SUM(token_count)");
    expect(capturedSql).toContain("MAX(rowid)");
    expect(capturedParams).toEqual(["session-1", "session-1"]);
    expect(stats.messages).toBe(350);
    expect(stats.lastTurnTokens).toBe(250);
    expect(stats.available).toBe(stats.budget - 350);
  });

  it("returns zeroes when the query result is null (no messages)", async () => {
    const store = new SqliteSessionStore({
      query() {
        return {
          get() {
            return null;
          },
        };
      },
    } as never);

    const stats = await store.getContextStats("session-1");

    expect(stats.messages).toBe(0);
    expect(stats.lastTurnTokens).toBe(0);
    expect(stats.available).toBe(stats.budget);
  });
});

describe("SqliteSessionStore", () => {
  it("deletes session children before removing the session row", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const execs: string[] = [];
    const store = new SqliteSessionStore({
      exec(sql: string) {
        execs.push(sql);
      },
      query(sql: string) {
        return {
          run(...params: unknown[]) {
            statements.push({ sql, params });
          },
        };
      },
    } as never);

    await store.delete("session-1");

    expect(execs).toEqual(["BEGIN IMMEDIATE;", "COMMIT;"]);
    expect(statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("DELETE FROM tool_uses"),
      "DELETE FROM git_checkpoints WHERE session_id = ?",
      "DELETE FROM validate_runs WHERE session_id = ?",
      "DELETE FROM messages WHERE session_id = ?",
      "DELETE FROM plans WHERE session_id = ?",
      "DELETE FROM sessions WHERE id = ?",
    ]);
    expect(statements.every(({ params }) => params[0] === "session-1")).toBe(
      true,
    );
  });
});

describe("AdapterConversationStore", () => {
  it("paginates deterministically when messages share a timestamp", async () => {
    const db = new RecordingConversationDb();
    const store = new AdapterConversationStore(db);

    await store.listPage("session-1", {
      before: "message-2",
      limit: 2,
    });

    expect(db.lastQuerySql).toContain("created_at =");
    expect(db.lastQuerySql).toContain("AND id < ?");
    expect(db.lastQueryParams).toEqual([
      "session-1",
      "message-2",
      "session-1",
      "message-2",
      "session-1",
      "message-2",
      3,
    ]);
  });

  it("adds a tenant guard when an org id is supplied", async () => {
    const db = new RecordingConversationDb();
    const store = new AdapterConversationStore(db);

    await store.listAll("session-1", "org-1");

    expect(db.lastQuerySql).toContain("sessions.org_id = ?");
    expect(db.lastQueryParams).toEqual(["session-1", "org-1"]);
  });
});

describe("SqliteMemoryStore", () => {
  it("inserts memory with all fields and pinned as integer", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const store = new SqliteMemoryStore({
      query(sql: string) {
        return {
          run(...params: unknown[]) {
            statements.push({ sql, params });
          },
          get() {
            return null;
          },
          all() {
            return [];
          },
        };
      },
    } as never);

    await store.insert({
      id: "mem-1",
      userId: "user-1",
      orgId: null,
      type: "user",
      name: "test-memory",
      description: "desc",
      body: "body content",
      pinned: true,
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:00.000Z",
    });

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("INSERT INTO memories");
    expect(statements[0]?.params).toContain(1);
    expect(statements[0]?.params).toContain("user-1");
    expect(statements[0]?.params).toContain("test-memory");
  });

  it("listByUser applies org filter when orgId is provided", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const store = new SqliteMemoryStore({
      query(sql: string) {
        return {
          all(...params: unknown[]) {
            queries.push({ sql, params: params.flat() });
            return [];
          },
        };
      },
    } as never);

    await store.listByUser("user-1", "org-1");

    expect(queries[0]?.sql).toContain("org_id = ?");
    expect(queries[0]?.params).toEqual(["user-1", "org-1"]);
  });

  it("listByUser without orgId omits org filter", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const store = new SqliteMemoryStore({
      query(sql: string) {
        return {
          all(...params: unknown[]) {
            queries.push({ sql, params: params.flat() });
            return [];
          },
        };
      },
    } as never);

    await store.listByUser("user-1");

    expect(queries[0]?.sql).not.toContain("org_id = ?");
    expect(queries[0]?.params).toEqual(["user-1"]);
  });
});

describe("SqliteHookRunStore", () => {
  it("inserts hook run with blocked as integer", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const store = new SqliteHookRunStore({
      query(sql: string) {
        return {
          run(...params: unknown[]) {
            statements.push({ sql, params });
          },
        };
      },
    } as never);

    await store.insert({
      id: "run-1",
      hookName: "pre_tool_call",
      eventType: "pre_tool_call",
      sessionId: "session-1",
      blocked: true,
      durationMs: 42,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    expect(statements[0]?.sql).toContain("INSERT INTO hook_runs");
    expect(statements[0]?.params).toContain(1);
    expect(statements[0]?.params).toContain("session-1");
  });

  it("listBySession applies default limit of 100", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const store = new SqliteHookRunStore({
      query(sql: string) {
        return {
          all(...params: unknown[]) {
            queries.push({ sql, params: params.flat() });
            return [];
          },
        };
      },
    } as never);

    await store.listBySession("session-1");

    expect(queries[0]?.params).toEqual(["session-1", 100]);
  });
});

describe("AdapterMemoryStore", () => {
  it("upsertByName uses ON CONFLICT DO UPDATE", async () => {
    const statements: string[] = [];
    const db = new RecordingMemoryDb(statements);
    const store = new AdapterMemoryStore(db);

    await store.upsertByName({
      id: "mem-1",
      userId: "user-1",
      orgId: null,
      type: "feedback",
      name: "my-memory",
      description: "desc",
      body: "body",
      pinned: false,
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:00.000Z",
    });

    expect(statements.some((sql) => sql.includes("ON CONFLICT"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DO UPDATE SET"))).toBe(true);
  });
});

class RecordingMemoryDb implements DbAdapter {
  constructor(private readonly statements: string[] = []) {}

  async query<T extends object>(): Promise<T[]> {
    return [];
  }

  async first<T extends object>(sql: string): Promise<T | null> {
    if (sql.includes("WHERE user_id = ? AND name = ?")) {
      return {
        id: "mem-1",
        userId: "user-1",
        orgId: null,
        type: "feedback",
        name: "my-memory",
        description: "desc",
        body: "body",
        pinned: 0,
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      } as T;
    }
    return null;
  }

  async execute(sql: string): Promise<void> {
    this.statements.push(sql);
  }

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

class RecordingConversationDb implements DbAdapter {
  lastQuerySql = "";
  lastQueryParams: unknown[] = [];

  async query<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    this.lastQuerySql = sql;
    this.lastQueryParams = params;
    return [];
  }

  async first<T extends object>(): Promise<T | null> {
    return { ok: 1 } as T;
  }

  async execute(): Promise<void> {}

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}
