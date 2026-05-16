import { describe, expect, it } from "vitest";
import { SqliteSessionStore } from "./stores";

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
