import { describe, expect, it } from "vitest";
import type { DbAdapter } from "./adapter";
import {
  AdapterConversationStore,
  AdapterFileSnapshotStore,
  AdapterInstalledPluginStore,
  AdapterMemoryStore,
  AdapterPermissionStore,
  SqliteApprovalRequestStore,
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
      "DELETE FROM file_snapshots WHERE session_id = ?",
      "DELETE FROM permission_denials WHERE session_id = ?",
      "DELETE FROM permission_allow_rules WHERE session_id = ?",
      "DELETE FROM approval_requests WHERE session_id = ?",
      "DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories)",
      "DELETE FROM validate_runs WHERE session_id = ?",
      "DELETE FROM messages WHERE session_id = ?",
      "DELETE FROM plans WHERE session_id = ?",
      "DELETE FROM sessions WHERE id = ?",
    ]);
    expect(
      statements
        .filter(({ params }) => params.length > 0)
        .every(({ params }) => params[0] === "session-1"),
    ).toBe(true);
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
      scope: "user",
      source: "manual",
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
      scope: "user",
      source: "manual",
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

describe("AdapterFileSnapshotStore", () => {
  it("diffs snapshots, summarizes turns, and evicts old rows", async () => {
    const db = new RecordingSnapshotDb();
    const store = new AdapterFileSnapshotStore(db);

    const diff = await store.diff("session-1", 1, 2);
    const turns = await store.listTurns("session-1");
    await store.evict("session-1", 3);

    expect(diff).toHaveLength(1);
    expect(diff[0]?.filePath).toBe("src/a.ts");
    expect(diff[0]?.patch).toContain("-before");
    expect(diff[0]?.patch).toContain("+after");
    expect(turns).toEqual([
      { turnIndex: 1, fileCount: 1, savedAt: "2026-05-21T00:00:00.000Z" },
      { turnIndex: 2, fileCount: 1, savedAt: "2026-05-21T00:01:00.000Z" },
    ]);
    expect(db.executed.at(-1)).toEqual({
      sql: "DELETE FROM file_snapshots WHERE session_id = ? AND turn_index < ?",
      params: ["session-1", 4],
    });
  });

  it("uses upsert semantics for save and restores the persisted snapshot", async () => {
    const db = new RecordingSnapshotDb();
    const store = new AdapterFileSnapshotStore(db);
    const snapshot = {
      id: "snap-3",
      sessionId: "session-1",
      turnIndex: 3,
      filePath: "src/b.ts",
      contentHash: "hash-3",
      content: "saved\n",
      savedAt: "2026-05-21T00:02:00.000Z",
    };

    await store.save(snapshot);
    const restored = await store.restore("session-1", 3);

    expect(db.executed[0]?.sql).toContain("INSERT OR REPLACE");
    expect(restored).toEqual([snapshot]);
  });
});

describe("SqliteApprovalRequestStore", () => {
  it("inserts, gets, and lists approval requests", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const request = {
      id: "approval-1",
      sessionId: "session-1",
      planId: "plan-1",
      planContent: "ship it",
      createdAt: "2026-05-21T00:00:00.000Z",
      expiresAt: "2026-05-21T00:30:00.000Z",
      status: "pending" as const,
      feedback: null,
    };
    const store = new SqliteApprovalRequestStore({
      query(sql: string) {
        return {
          run(...params: unknown[]) {
            statements.push({ sql, params });
          },
          get() {
            return request;
          },
          all() {
            return [request];
          },
        };
      },
    } as never);

    await store.insert(request);

    expect(statements[0]?.sql).toContain("INSERT INTO approval_requests");
    await expect(store.get("approval-1")).resolves.toEqual(request);
    await expect(store.listBySession("session-1")).resolves.toEqual([request]);
  });

  it("updates approval state and re-reads the request", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const store = new SqliteApprovalRequestStore({
      query(sql: string) {
        return {
          run(...params: unknown[]) {
            statements.push({ sql, params });
          },
          get() {
            return {
              id: "approval-1",
              sessionId: "session-1",
              planId: "plan-1",
              planContent: "ship it",
              createdAt: "2026-05-21T00:00:00.000Z",
              expiresAt: "2026-05-21T00:30:00.000Z",
              status: "approved",
              feedback: "looks good",
            };
          },
        };
      },
    } as never);

    const updated = await store.applyDecision("approval-1", {
      approved: true,
      feedback: "looks good",
    });

    expect(statements[0]?.sql).toContain("UPDATE approval_requests");
    expect(updated?.status).toBe("approved");
    expect(updated?.feedback).toBe("looks good");
  });
});

describe("AdapterPermissionStore", () => {
  it("round-trips denials and allow-rules", async () => {
    const db = new RecordingPermissionDb();
    const store = new AdapterPermissionStore(db);

    await store.insertDenial({
      id: "denial-1",
      sessionId: "session-1",
      tool: "bash",
      input: { cmd: "rm -rf" },
      deniedBy: "rule",
      reason: "dangerous",
      createdAt: "2026-05-21T00:00:00.000Z",
    });
    const denials = await store.listDenials("session-1");
    await store.insertAllowRule({
      id: "rule-1",
      sessionId: null,
      orgId: null,
      tool: "read_file",
      inputPattern: "src/**",
      createdAt: "2026-05-21T00:00:00.000Z",
    });
    const rules = await store.listAllowRules("session-1", "org-1");

    expect(denials[0]).toMatchObject({
      id: "denial-1",
      deniedBy: "rule",
      input: { cmd: "rm -rf" },
    });
    expect(rules[0]).toMatchObject({
      id: "rule-1",
      tool: "read_file",
      inputPattern: "src/**",
    });
    expect(db.lastQueryParams).toEqual(["org-1", "session-1"]);
  });
});

describe("AdapterInstalledPluginStore", () => {
  it("upserts and re-fetches plugin records", async () => {
    const db = new RecordingPluginDb();
    const store = new AdapterInstalledPluginStore(db);

    const record = await store.upsert(
      {
        name: "example",
        version: "1.0.0",
        description: "desc",
        author: "author",
        exports: [],
      },
      "2026-05-21T00:00:00.000Z",
    );

    expect(record.name).toBe("example");
    expect(record.manifestJson).toContain('"name":"example"');
    expect(db.executed.some((sql) => sql.includes("ON CONFLICT(name)"))).toBe(
      true,
    );
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

class RecordingSnapshotDb implements DbAdapter {
  readonly executed: Array<{ sql: string; params: unknown[] }> = [];
  readonly saved = new Map<string, object>();

  async query<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (sql.includes("GROUP BY turn_index")) {
      return [
        {
          turnIndex: 1,
          fileCount: 1,
          savedAt: "2026-05-21T00:00:00.000Z",
        },
        {
          turnIndex: 2,
          fileCount: 1,
          savedAt: "2026-05-21T00:01:00.000Z",
        },
      ] as T[];
    }

    if (params[1] === 1) {
      return [
        {
          id: "snap-1",
          sessionId: "session-1",
          turnIndex: 1,
          filePath: "src/a.ts",
          contentHash: "hash-1",
          content: "before\n",
          savedAt: "2026-05-21T00:00:00.000Z",
        },
      ] as T[];
    }

    const saved = this.saved.get(`${params[0]}:${params[1]}`);
    if (saved) {
      return [saved] as T[];
    }

    return [
      {
        id: "snap-2",
        sessionId: "session-1",
        turnIndex: 2,
        filePath: "src/a.ts",
        contentHash: "hash-2",
        content: "after\n",
        savedAt: "2026-05-21T00:01:00.000Z",
      },
    ] as T[];
  }

  async first<T extends object>(): Promise<T | null> {
    return { maxTurn: 7 } as T;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.executed.push({ sql, params });
    if (sql.includes("file_snapshots") && sql.includes("VALUES")) {
      this.saved.set(`${params[1]}:${params[2]}`, {
        id: params[0],
        sessionId: params[1],
        turnIndex: params[2],
        filePath: params[3],
        contentHash: params[4],
        content: params[5],
        savedAt: params[6],
      });
    }
  }

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

class RecordingPermissionDb implements DbAdapter {
  lastQueryParams: unknown[] = [];

  async query<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    this.lastQueryParams = params;
    if (sql.includes("permission_denials")) {
      return [
        {
          id: "denial-1",
          sessionId: "session-1",
          tool: "bash",
          input: '{"cmd":"rm -rf"}',
          deniedBy: "rule",
          reason: "dangerous",
          createdAt: "2026-05-21T00:00:00.000Z",
        },
      ] as T[];
    }

    return [
      {
        id: "rule-1",
        sessionId: null,
        orgId: "org-1",
        tool: "read_file",
        inputPattern: "src/**",
        createdAt: "2026-05-21T00:00:00.000Z",
      },
    ] as T[];
  }

  async first<T extends object>(): Promise<T | null> {
    return null;
  }

  async execute(): Promise<void> {}

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}

class RecordingPluginDb implements DbAdapter {
  readonly executed: string[] = [];

  async query<T extends object>(): Promise<T[]> {
    return [];
  }

  async first<T extends object>(): Promise<T | null> {
    return {
      name: "example",
      version: "1.0.0",
      description: "desc",
      author: "author",
      manifestJson:
        '{"name":"example","version":"1.0.0","description":"desc","author":"author","exports":[]}',
      installedAt: "2026-05-21T00:00:00.000Z",
    } as T;
  }

  async execute(sql: string): Promise<void> {
    this.executed.push(sql);
  }

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}
