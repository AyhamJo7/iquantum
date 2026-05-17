import type { Database } from "bun:sqlite";
import type { DbAdapter } from "./adapter";

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
  {
    version: 4,
    sql: `
      ALTER TABLE messages
        ADD COLUMN task_id TEXT REFERENCES plans(id);

      CREATE INDEX idx_messages_session_task_id
        ON messages(session_id, task_id);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE sessions
        ADD COLUMN mode TEXT NOT NULL DEFAULT 'piv'
          CHECK (mode IN ('piv', 'chat'));
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free'
          CHECK (plan IN ('free', 'pro', 'enterprise')),
        sandbox_quota_hours INTEGER NOT NULL DEFAULT 10,
        stripe_customer_id TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member'
          CHECK (role IN ('owner', 'member')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_users_org_id ON users(org_id);
      CREATE INDEX idx_users_email ON users(email);
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        last_used_at TEXT,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_api_tokens_user_id ON api_tokens(user_id);
      CREATE INDEX idx_api_tokens_token_hash ON api_tokens(token_hash);
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id);
      ALTER TABLE sessions ADD COLUMN org_id  TEXT REFERENCES organizations(id);
      CREATE INDEX idx_sessions_org_id  ON sessions(org_id);
      CREATE INDEX idx_sessions_user_id ON sessions(user_id);
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE billing_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),
        event_type TEXT NOT NULL
          CHECK (event_type IN ('container_start','container_minute','token_call')),
        quantity REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_billing_events_org_created ON billing_events(org_id, created_at);
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

/**
 * Cloud mode is new in v2.0, so Postgres starts from the latest schema instead
 * of replaying SQLite-specific historical migrations (notably the v1 JSON
 * backfill that relies on SQLite JSON functions). The bootstrap is idempotent
 * and records the same logical schema version as the SQLite path.
 */
export async function initializePostgresSchema(db: DbAdapter): Promise<void> {
  await db.transaction(async (tx) => {
    for (const statement of postgresBootstrapStatements) {
      await tx.execute(statement);
    }
  });
}

const postgresBootstrapStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free'
      CHECK (plan IN ('free', 'pro', 'enterprise')),
    sandbox_quota_hours INTEGER NOT NULL DEFAULT 10,
    stripe_customer_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
      CHECK (role IN ('owner', 'member')),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    container_id TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    config TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'piv'
      CHECK (mode IN ('piv', 'chat')),
    user_id TEXT REFERENCES users(id),
    org_id TEXT REFERENCES organizations(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    feedback TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    task_id TEXT REFERENCES plans(id),
    role TEXT NOT NULL,
    phase TEXT NOT NULL,
    model TEXT,
    content TEXT NOT NULL,
    has_thinking INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL,
    compaction_boundary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS validate_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    plan_id TEXT NOT NULL REFERENCES plans(id),
    attempt INTEGER NOT NULL,
    exit_code INTEGER NOT NULL,
    stdout TEXT NOT NULL,
    stderr TEXT NOT NULL,
    passed INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS git_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    validate_run_id TEXT NOT NULL REFERENCES validate_runs(id),
    commit_hash TEXT NOT NULL,
    commit_message TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS repo_map_cache (
    repo_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    map_json TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repo_path, content_hash)
  )`,
  `CREATE TABLE IF NOT EXISTS tool_uses (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id),
    tool_name TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT,
    approved INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS billing_events (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES organizations(id),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    event_type TEXT NOT NULL
      CHECK (event_type IN ('container_start','container_minute','token_call')),
    quantity REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '[]',
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_users_org_id ON users(org_id)",
  "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_org_id ON sessions(org_id)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_messages_session_task_id ON messages(session_id, task_id)",
  "CREATE INDEX IF NOT EXISTS idx_plans_session_id ON plans(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_validate_runs_session_id ON validate_runs(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_git_checkpoints_session_id ON git_checkpoints(session_id)",
  "CREATE INDEX IF NOT EXISTS idx_tool_uses_message_id ON tool_uses(message_id)",
  "CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash)",
  "CREATE INDEX IF NOT EXISTS idx_billing_events_org_created ON billing_events(org_id, created_at)",
  `INSERT INTO schema_migrations (version, applied_at)
   VALUES (${latestSchemaVersion}, CURRENT_TIMESTAMP)
   ON CONFLICT (version) DO NOTHING`,
] as const;

function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version;").get() as {
    user_version?: number;
  } | null;
  return row?.user_version ?? 0;
}
