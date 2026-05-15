import type { Database } from "bun:sqlite";

export function initializeSchema(db: Database): void {
  db.exec(`
    PRAGMA user_version = 1;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      container_id TEXT NOT NULL,
      volume_id TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      phase TEXT NOT NULL,
      model TEXT,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      feedback TEXT,
      created_at TEXT NOT NULL,
      approved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS validate_runs (
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

    CREATE TABLE IF NOT EXISTS git_checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      validate_run_id TEXT NOT NULL REFERENCES validate_runs(id),
      commit_hash TEXT NOT NULL,
      commit_message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repo_map_cache (
      repo_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      map_json TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (repo_path, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id
      ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_plans_session_id
      ON plans(session_id);
    CREATE INDEX IF NOT EXISTS idx_validate_runs_session_id
      ON validate_runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_git_checkpoints_session_id
      ON git_checkpoints(session_id);
  `);
}
