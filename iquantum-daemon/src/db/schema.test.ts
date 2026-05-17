import { describe, expect, it } from "vitest";
import type { DbAdapter } from "./adapter";
import {
  initializePostgresSchema,
  initializeSchema,
  latestSchemaVersion,
} from "./schema";

describe("initializeSchema", () => {
  it("applies pending migrations in order and records the new version", () => {
    const statements: string[] = [];
    const db = fakeDb(0, statements);

    initializeSchema(db);

    expect(statements).toContain("BEGIN IMMEDIATE;");
    expect(
      statements.some((sql) => sql.includes("CREATE TABLE sessions")),
    ).toBe(true);
    expect(statements).toContain(
      `PRAGMA user_version = ${latestSchemaVersion};`,
    );
    expect(statements).toContain("COMMIT;");
  });

  it("upgrades v1 databases with v2 message columns, tools, and task scope", () => {
    const statements: string[] = [];

    initializeSchema(fakeDb(1, statements));

    expect(
      statements.some((sql) => sql.includes("ADD COLUMN has_thinking")),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes("ADD COLUMN compaction_boundary")),
    ).toBe(true);
    expect(
      statements.some((sql) => sql.includes("CREATE TABLE tool_uses")),
    ).toBe(true);
    expect(statements.some((sql) => sql.includes("ADD COLUMN task_id"))).toBe(
      true,
    );
    expect(statements).toContain("PRAGMA user_version = 2;");
    expect(statements).toContain("PRAGMA user_version = 3;");
    expect(statements).toContain("PRAGMA user_version = 4;");
  });

  it("does nothing when the schema is already current", () => {
    const statements: string[] = [];

    initializeSchema(fakeDb(latestSchemaVersion, statements));

    expect(statements).toEqual([]);
  });

  it("rejects databases newer than this daemon understands", () => {
    expect(() => initializeSchema(fakeDb(latestSchemaVersion + 1, []))).toThrow(
      "newer than supported",
    );
  });

  it("bootstraps the latest Postgres schema idempotently", async () => {
    const statements: string[] = [];
    await initializePostgresSchema(fakeAdapter(statements));

    expect(
      statements.some((sql) =>
        sql.includes("CREATE TABLE IF NOT EXISTS organizations"),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes("CREATE TABLE IF NOT EXISTS api_tokens"),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes(`VALUES (${latestSchemaVersion}, CURRENT_TIMESTAMP)`),
      ),
    ).toBe(true);
  });
});

function fakeDb(version: number, statements: string[]) {
  return {
    exec(sql: string) {
      statements.push(sql);
    },
    query(sql: string) {
      if (sql !== "PRAGMA user_version;") {
        throw new Error(`unexpected query: ${sql}`);
      }

      return {
        get() {
          return { user_version: version };
        },
      };
    },
  } as never;
}

function fakeAdapter(statements: string[]): DbAdapter {
  return {
    async query() {
      return [];
    },
    async first() {
      return null;
    },
    async execute(sql: string) {
      statements.push(sql);
    },
    async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async close() {},
  };
}
