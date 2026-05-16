import { describe, expect, it } from "vitest";
import { initializeSchema, latestSchemaVersion } from "./schema";

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

  it("upgrades v1 databases with v2 message columns and tool uses", () => {
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
    expect(statements).toContain("PRAGMA user_version = 2;");
    expect(statements).toContain("PRAGMA user_version = 3;");
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
