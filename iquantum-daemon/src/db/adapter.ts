import type { Database } from "bun:sqlite";
import { createRequire } from "node:module";
import postgres, { type Sql } from "postgres";

export interface DbRow extends Record<string, unknown> {}

export interface DbAdapter {
  query<T extends object>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T extends object>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class SqliteAdapter implements DbAdapter {
  constructor(readonly db: Database) {}

  async query<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.db.query(sql).all(...(params as never[])) as T[];
  }

  async first<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    return (this.db.query(sql).get(...(params as never[])) as T | null) ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.db.query(sql).run(...(params as never[]));
  }

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export class PostgresAdapter implements DbAdapter {
  readonly #sql: Sql;

  constructor(sqlOrUrl: Sql | string) {
    this.#sql = typeof sqlOrUrl === "string" ? postgres(sqlOrUrl) : sqlOrUrl;
  }

  async query<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.#sql.unsafe(
      rewritePlaceholders(sql),
      params as never[],
    )) as T[];
  }

  async first<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.#sql.unsafe(rewritePlaceholders(sql), params as never[]);
  }

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    return (await this.#sql.begin(async (sql) =>
      fn(new PostgresAdapter(sql as unknown as Sql)),
    )) as T;
  }

  async close(): Promise<void> {
    await this.#sql.end();
  }
}

export function createDbAdapter(databaseUrl?: string): DbAdapter {
  if (
    databaseUrl?.startsWith("postgres://") ||
    databaseUrl?.startsWith("postgresql://")
  ) {
    return new PostgresAdapter(databaseUrl);
  }

  const sqlitePath = databaseUrl?.startsWith("file:")
    ? databaseUrl.slice(5)
    : ":memory:";
  const require = createRequire(import.meta.url);
  const { Database: BunDatabase } =
    require("bun:sqlite") as typeof import("bun:sqlite");
  return new SqliteAdapter(new BunDatabase(sqlitePath));
}

export function rewritePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
