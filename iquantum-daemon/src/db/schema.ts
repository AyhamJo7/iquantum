import type { Database } from "bun:sqlite";

interface Migration {
  version: number;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        container_id TEXT NOT NULL,
        volume_id TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        phase TEXT NOT NULL,
        model TEXT,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        feedback TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );

      CREATE TABLE validate_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        plan_id TEXT NOT NULL REFERENCES plans(id),
        attempt INTEGER NOT NULL,
        exit_code INTEGER NOT NULL,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        passed INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE git_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        validate_run_id TEXT NOT NULL REFERENCES validate_runs(id),
        commit_hash TEXT NOT NULL,
        commit_message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE repo_map_cache (
        repo_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        map_json TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (repo_path, content_hash)
      );

      CREATE INDEX idx_messages_session_id ON messages(session_id);
      CREATE INDEX idx_plans_session_id ON plans(session_id);
      CREATE INDEX idx_validate_runs_session_id ON validate_runs(session_id);
      CREATE INDEX idx_git_checkpoints_session_id ON git_checkpoints(session_id);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE messages
        ADD COLUMN has_thinking INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages
        ADD COLUMN compaction_boundary INTEGER NOT NULL DEFAULT 0;

      UPDATE messages
      SET content = json_array(json_object('type', 'text', 'text', content))
      WHERE json_valid(content) = 0;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE tool_uses (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id),
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        approved INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tool_uses_message_id ON tool_uses(message_id);
    `,
  },
];

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0;

export function initializeSchema(db: Database): void {
  const currentVersion = readUserVersion(db);

  if (currentVersion > latestSchemaVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${latestSchemaVersion}`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    db.exec("BEGIN IMMEDIATE;");

    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version};`);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
}

function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version;").get() as {
    user_version?: number;
  } | null;
  return row?.user_version ?? 0;
}
