import { describe, expect, it } from "vitest";
import type { DbAdapter } from "./adapter";
import { AdapterConversationStore, SqliteSessionStore } from "./stores";

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
