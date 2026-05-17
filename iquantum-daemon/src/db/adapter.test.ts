import { describe, expect, it } from "vitest";
import { PostgresAdapter, rewritePlaceholders, SqliteAdapter } from "./adapter";

describe("DbAdapter", () => {
  it("rewrites sqlite placeholders for postgres", () => {
    expect(rewritePlaceholders("a = ? AND b = ?")).toBe("a = $1 AND b = $2");
  });

  it("wraps sqlite-style query/get/run APIs", async () => {
    const calls: unknown[][] = [];
    const db = new SqliteAdapter({
      query(sql: string) {
        return {
          all(...params: unknown[]) {
            calls.push(["all", sql, params]);
            return [{ id: "1" }];
          },
          get(...params: unknown[]) {
            calls.push(["get", sql, params]);
            return { id: "1" };
          },
          run(...params: unknown[]) {
            calls.push(["run", sql, params]);
          },
        };
      },
      exec(sql: string) {
        calls.push(["exec", sql]);
      },
      close() {
        calls.push(["close"]);
      },
    } as never);

    expect(await db.query("SELECT * FROM items WHERE id = ?", ["1"])).toEqual([
      { id: "1" },
    ]);
    expect(await db.first("SELECT * FROM items WHERE id = ?", ["1"])).toEqual({
      id: "1",
    });
    await db.execute("DELETE FROM items WHERE id = ?", ["1"]);
    await db.close();
    expect(calls).toContainEqual(["close"]);
  });

  it.skipIf(!process.env.TEST_POSTGRES_URL)(
    "supports postgres CRUD",
    async () => {
      const db = new PostgresAdapter(process.env.TEST_POSTGRES_URL as string);
      await db.execute("DROP TABLE IF EXISTS adapter_items");
      await db.execute(
        "CREATE TABLE adapter_items (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
      );
      await db.execute("INSERT INTO adapter_items (id, name) VALUES (?, ?)", [
        "1",
        "one",
      ]);
      expect(
        await db.first<{ id: string; name: string }>(
          "SELECT * FROM adapter_items WHERE id = ?",
          ["1"],
        ),
      ).toEqual({ id: "1", name: "one" });
      await db.execute("DROP TABLE adapter_items");
      await db.close();
    },
  );
});
