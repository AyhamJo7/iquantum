import type { Database } from "bun:sqlite";
import type { GitCheckpointPage, GitCheckpointStore } from "@iquantum/git";
import type { PIVStore } from "@iquantum/piv-engine";
import type {
  AllowRule,
  ApprovalDecision,
  ApprovalRequest,
  ContextStats,
  FileSnapshot,
  GitCheckpoint,
  HookRun,
  Memory,
  Message,
  PermissionDenial,
  Plan,
  PluginManifest,
  Session,
  SessionStatus,
  ValidateRun,
} from "@iquantum/types";
import { CONTEXT_TOKEN_BUDGET } from "@iquantum/types";
import { createPatch } from "diff";

export type { ContextStats };

export interface SessionStore {
  insert(session: Session): Promise<void>;
  get(sessionId: string, orgId?: string): Promise<Session | null>;
  update(
    sessionId: string,
    updates: Partial<Pick<Session, "coordinatorMode" | "effort">>,
  ): Promise<Session>;
  delete(sessionId: string): Promise<void>;
  listByOrg(orgId: string): Promise<Session[]>;
  listChildren?(): Promise<Session[]>;
  getContextStats?(sessionId: string): Promise<ContextStats>;
}

export type ConversationRole = "user" | "assistant" | "tool_result";

export interface ConversationContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: ConversationRole;
  content: ConversationContentBlock[];
  hasThinking: boolean;
  tokenCount: number;
  compactionBoundary: boolean;
  compactionAnchor?: boolean;
  bodyCompressed?: Uint8Array | null;
  createdAt: string;
}

export interface ConversationPage {
  messages: ConversationMessage[];
  nextCursor: string | null;
}

export interface ConversationStore {
  insert(message: ConversationMessage): Promise<void>;
  listPage(
    sessionId: string,
    options: { before?: string; limit: number },
    orgId?: string,
  ): Promise<ConversationPage>;
  listAll(sessionId: string, orgId?: string): Promise<ConversationMessage[]>;
  deleteAll(sessionId: string, orgId?: string): Promise<void>;
}

export class InvalidConversationCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Unknown conversation cursor ${cursor}`);
    this.name = "InvalidConversationCursorError";
  }
}

export class InvalidCheckpointCursorError extends Error {
  constructor(readonly cursor: string) {
    super("invalid_checkpoint_cursor");
    this.name = "InvalidCheckpointCursorError";
  }
}

export class SqliteSessionStore implements SessionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async insert(session: Session): Promise<void> {
    this.#db
      .query(
        `INSERT INTO sessions (
          id, status, repo_path, container_id, volume_id, config, mode,
          effort, worktree_path, worktree_branch, start_checkpoint_hash,
          parent_session_id, agent_name, agent_color, coordinator_mode,
          user_id, org_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.status,
        session.repoPath,
        session.containerId,
        session.volumeId,
        JSON.stringify(session.config),
        session.mode,
        session.effort,
        session.worktreePath,
        session.worktreeBranch,
        session.startCheckpointHash,
        session.parentSessionId ?? null,
        session.agentName ?? null,
        session.agentColor ?? null,
        Number(session.coordinatorMode ?? false),
        session.userId,
        session.orgId,
        session.createdAt,
        session.updatedAt,
      );
  }

  async get(sessionId: string, orgId?: string): Promise<Session | null> {
    const row = this.#db
      .query(
        `SELECT
          id,
          status,
          repo_path AS "repoPath",
          container_id AS "containerId",
          volume_id AS "volumeId",
          config,
          mode,
          effort,
          worktree_path AS "worktreePath",
          worktree_branch AS "worktreeBranch",
          start_checkpoint_hash AS "startCheckpointHash",
          parent_session_id AS "parentSessionId",
          agent_name AS "agentName",
          agent_color AS "agentColor",
          coordinator_mode AS "coordinatorMode",
          user_id AS "userId",
          org_id AS "orgId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM sessions
        WHERE id = ? ${orgId ? "AND org_id = ?" : ""}`,
      )
      .get(...(orgId ? [sessionId, orgId] : [sessionId])) as SessionRow | null;

    if (!row) {
      return null;
    }

    return {
      ...row,
      config: JSON.parse(row.config) as Record<string, unknown>,
    };
  }

  async update(
    sessionId: string,
    updates: Partial<Pick<Session, "coordinatorMode" | "effort">>,
  ): Promise<Session> {
    const now = new Date().toISOString();
    if (updates.effort !== undefined) {
      this.#db
        .query("UPDATE sessions SET effort = ?, updated_at = ? WHERE id = ?")
        .run(updates.effort, now, sessionId);
    }
    if (updates.coordinatorMode !== undefined) {
      this.#db
        .query(
          "UPDATE sessions SET coordinator_mode = ?, updated_at = ? WHERE id = ?",
        )
        .run(Number(updates.coordinatorMode), now, sessionId);
    }
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }

  async getContextStats(sessionId: string): Promise<ContextStats> {
    const row = this.#db
      .query(
        `SELECT
          COALESCE(SUM(token_count), 0) AS total,
          COALESCE(MAX(CASE WHEN rowid = (SELECT MAX(rowid) FROM messages WHERE session_id = ?) THEN token_count ELSE 0 END), 0) AS lastTurn
        FROM messages
        WHERE session_id = ?`,
      )
      .get(sessionId, sessionId) as { total: number; lastTurn: number } | null;

    const total = row?.total ?? 0;
    const lastTurnTokens = row?.lastTurn ?? 0;
    return {
      systemPrompt: 0,
      memory: 0,
      repoMap: 0,
      messages: total,
      lastTurnTokens,
      budget: CONTEXT_TOKEN_BUDGET,
      available: Math.max(0, CONTEXT_TOKEN_BUDGET - total),
    };
  }

  async delete(sessionId: string): Promise<void> {
    this.#db.exec("BEGIN IMMEDIATE;");

    try {
      this.#db
        .query(
          `DELETE FROM tool_uses
           WHERE message_id IN (
             SELECT id FROM messages WHERE session_id = ?
           )`,
        )
        .run(sessionId);
      this.#db
        .query("DELETE FROM git_checkpoints WHERE session_id = ?")
        .run(sessionId);
      this.#db
        .query("DELETE FROM file_snapshots WHERE session_id = ?")
        .run(sessionId);
      this.#db
        .query("DELETE FROM permission_denials WHERE session_id = ?")
        .run(sessionId);
      this.#db
        .query("DELETE FROM permission_allow_rules WHERE session_id = ?")
        .run(sessionId);
      this.#db
        .query("DELETE FROM approval_requests WHERE session_id = ?")
        .run(sessionId);
      this.#db
        .query(
          "DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories)",
        )
        .run();
      this.#db
        .query("DELETE FROM validate_runs WHERE session_id = ?")
        .run(sessionId);
      this.#db
        .query("DELETE FROM messages WHERE session_id = ?")
        .run(sessionId);
      this.#db.query("DELETE FROM plans WHERE session_id = ?").run(sessionId);
      this.#db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
      this.#db.exec("COMMIT;");
    } catch (error) {
      this.#db.exec("ROLLBACK;");
      throw error;
    }
  }

  async listByOrg(orgId: string): Promise<Session[]> {
    const rows = this.#db
      .query(
        `SELECT
          id,
          status,
          repo_path AS "repoPath",
          container_id AS "containerId",
              volume_id AS "volumeId",
              config,
              mode,
              effort,
              worktree_path AS "worktreePath",
              worktree_branch AS "worktreeBranch",
              start_checkpoint_hash AS "startCheckpointHash",
              parent_session_id AS "parentSessionId",
              agent_name AS "agentName",
              agent_color AS "agentColor",
              coordinator_mode AS "coordinatorMode",
              user_id AS "userId",
              org_id AS "orgId",
              created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM sessions
        WHERE org_id = ?
        ORDER BY created_at, id`,
      )
      .all(orgId) as SessionRow[];
    return rows.map((row) => ({
      ...row,
      config: JSON.parse(row.config) as Record<string, unknown>,
    }));
  }

  async listChildren(): Promise<Session[]> {
    const rows = this.#db
      .query(
        `SELECT
          id,
          status,
          repo_path AS "repoPath",
          container_id AS "containerId",
          volume_id AS "volumeId",
          config,
          mode,
          effort,
          worktree_path AS "worktreePath",
          worktree_branch AS "worktreeBranch",
          start_checkpoint_hash AS "startCheckpointHash",
          parent_session_id AS "parentSessionId",
          agent_name AS "agentName",
          agent_color AS "agentColor",
          coordinator_mode AS "coordinatorMode",
          user_id AS "userId",
          org_id AS "orgId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM sessions
        WHERE parent_session_id IS NOT NULL
        ORDER BY created_at, id`,
      )
      .all() as SessionRow[];
    return rows.map((row) => ({
      ...row,
      config: JSON.parse(row.config) as Record<string, unknown>,
    }));
  }
}

export class SqlitePIVStore implements PIVStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    this.#db
      .query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), sessionId);
  }

  async insertMessage(message: Message): Promise<void> {
    this.#db
      .query(
        `INSERT INTO messages (
          id, session_id, task_id, role, phase, model, content,
          has_thinking, token_count, compaction_boundary, compaction_anchor,
          body_compressed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.taskId,
        message.role,
        message.phase,
        message.model,
        encodeTextContent(message.content),
        Number(message.hasThinking),
        message.tokenCount,
        Number(message.compactionBoundary),
        Number(message.compactionAnchor ?? false),
        message.bodyCompressed ?? null,
        message.createdAt,
      );
  }

  async listMessagesByTask(
    sessionId: string,
    taskId: string,
  ): Promise<Message[]> {
    const rows = this.#db
      .query(
        `SELECT
          id,
          session_id AS "sessionId",
          task_id AS "taskId",
          role,
          phase,
          model,
          content,
          has_thinking AS "hasThinking",
          token_count AS "tokenCount",
          compaction_boundary AS "compactionBoundary",
          compaction_anchor AS "compactionAnchor",
          body_compressed AS "bodyCompressed",
          created_at AS "createdAt"
        FROM messages
        WHERE session_id = ? AND task_id = ?
        ORDER BY created_at, rowid
        LIMIT 2000`,
      )
      .all(sessionId, taskId) as MessageRow[];

    return rows.map(toMessage);
  }

  async insertPlan(plan: Plan): Promise<void> {
    this.#db
      .query(
        `INSERT INTO plans (
          id, session_id, content, status, feedback, created_at, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.sessionId,
        plan.content,
        plan.status,
        plan.feedback,
        plan.createdAt,
        plan.approvedAt,
      );
  }

  async getPlan(planId: string): Promise<Plan | null> {
    return this.#db
      .query(
        `SELECT
          id,
          session_id AS "sessionId",
          content,
          status,
          feedback,
          created_at AS "createdAt",
          approved_at AS "approvedAt"
        FROM plans
        WHERE id = ?`,
      )
      .get(planId) as Plan | null;
  }

  async getCurrentPlan(sessionId: string): Promise<Plan | null> {
    return this.#db
      .query(
        `SELECT
          id,
          session_id AS "sessionId",
          content,
          status,
          feedback,
          created_at AS "createdAt",
          approved_at AS "approvedAt"
        FROM plans
        WHERE session_id = ? AND status = 'pending'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
      )
      .get(sessionId) as Plan | null;
  }

  async updatePlan(
    planId: string,
    updates: Pick<Plan, "approvedAt" | "feedback" | "status">,
  ): Promise<Plan> {
    this.#db
      .query(
        "UPDATE plans SET status = ?, feedback = ?, approved_at = ? WHERE id = ?",
      )
      .run(updates.status, updates.feedback, updates.approvedAt, planId);
    const plan = await this.getPlan(planId);

    if (!plan) {
      throw new Error(`Unknown plan ${planId}`);
    }

    return plan;
  }

  async insertValidateRun(run: ValidateRun): Promise<void> {
    this.#db
      .query(
        `INSERT INTO validate_runs (
          id, session_id, plan_id, attempt, exit_code, stdout, stderr, passed, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.sessionId,
        run.planId,
        run.attempt,
        run.exitCode,
        run.stdout,
        run.stderr,
        Number(run.passed),
        run.createdAt,
      );
  }
}

export class SqliteConversationStore implements ConversationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async insert(message: ConversationMessage): Promise<void> {
    this.#db
      .query(
        `INSERT INTO messages (
          id, session_id, task_id, role, phase, model, content,
          has_thinking, token_count, compaction_boundary, compaction_anchor,
          body_compressed, created_at
        ) VALUES (?, ?, NULL, ?, 'plan', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        JSON.stringify(message.content),
        Number(message.hasThinking),
        message.tokenCount,
        Number(message.compactionBoundary),
        Number(message.compactionAnchor ?? false),
        message.bodyCompressed ?? null,
        message.createdAt,
      );
  }

  async listPage(
    sessionId: string,
    options: { before?: string; limit: number },
    orgId?: string,
  ): Promise<ConversationPage> {
    const tenantClause = orgId
      ? "AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = messages.session_id AND sessions.org_id = ?)"
      : "";
    if (options.before) {
      const cursor = this.#db
        .query(
          `SELECT 1 FROM messages
           WHERE id = ? AND session_id = ? AND task_id IS NULL
           ${tenantClause}`,
        )
        .get(
          ...(orgId
            ? [options.before, sessionId, orgId]
            : [options.before, sessionId]),
        );

      if (!cursor) {
        throw new InvalidConversationCursorError(options.before);
      }
    }

    const beforeClause = options.before
      ? "AND rowid < (SELECT rowid FROM messages WHERE id = ? AND session_id = ? AND task_id IS NULL)"
      : "";
    const params = options.before
      ? [
          sessionId,
          ...(orgId ? [orgId] : []),
          options.before,
          sessionId,
          options.limit + 1,
        ]
      : [sessionId, ...(orgId ? [orgId] : []), options.limit + 1];
    const rows = this.#db
      .query(
        `SELECT
          id,
          session_id AS "sessionId",
          role,
          content,
          has_thinking AS "hasThinking",
          token_count AS "tokenCount",
          compaction_boundary AS "compactionBoundary",
          compaction_anchor AS "compactionAnchor",
          body_compressed AS "bodyCompressed",
          created_at AS "createdAt"
        FROM messages
        WHERE session_id = ? AND task_id IS NULL
        ${tenantClause}
        ${beforeClause}
        ORDER BY rowid DESC
        LIMIT ?`,
      )
      .all(...params) as ConversationMessageRow[];
    const hasMore = rows.length > options.limit;
    const pageRows = rows.slice(0, options.limit);
    const messages = pageRows.reverse().map(toConversationMessage);

    return {
      messages,
      nextCursor: hasMore ? (messages[0]?.id ?? null) : null,
    };
  }

  async listAll(
    sessionId: string,
    orgId?: string,
  ): Promise<ConversationMessage[]> {
    const tenantClause = orgId
      ? "AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = messages.session_id AND sessions.org_id = ?)"
      : "";
    const rows = this.#db
      .query(
        `SELECT
          id,
          session_id AS "sessionId",
          role,
          content,
          has_thinking AS "hasThinking",
          token_count AS "tokenCount",
          compaction_boundary AS "compactionBoundary",
          compaction_anchor AS "compactionAnchor",
          body_compressed AS "bodyCompressed",
          created_at AS "createdAt"
        FROM messages
        WHERE session_id = ? AND task_id IS NULL
        ${tenantClause}
        ORDER BY rowid`,
      )
      .all(
        ...(orgId ? [sessionId, orgId] : [sessionId]),
      ) as ConversationMessageRow[];

    return rows.map(toConversationMessage);
  }

  async deleteAll(sessionId: string, orgId?: string): Promise<void> {
    const tenantClause = orgId
      ? "AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = messages.session_id AND sessions.org_id = ?)"
      : "";
    this.#db
      .query(
        `DELETE FROM messages
         WHERE session_id = ? AND task_id IS NULL
         ${tenantClause}`,
      )
      .run(...(orgId ? [sessionId, orgId] : [sessionId]));
  }
}

export class SqliteGitCheckpointStore implements GitCheckpointStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async insert(checkpoint: GitCheckpoint): Promise<void> {
    this.#db
      .query(
        `INSERT INTO git_checkpoints (
          id, session_id, validate_run_id, commit_hash, commit_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.id,
        checkpoint.sessionId,
        checkpoint.validateRunId,
        checkpoint.commitHash,
        checkpoint.commitMessage,
        checkpoint.createdAt,
      );
  }

  async listBySession(
    sessionId: string,
    options: { before?: string; limit: number } = { limit: 50 },
  ): Promise<GitCheckpointPage> {
    if (options.before) {
      const cursor = this.#db
        .query("SELECT 1 FROM git_checkpoints WHERE id = ? AND session_id = ?")
        .get(options.before, sessionId);
      if (!cursor) {
        throw new InvalidCheckpointCursorError(options.before);
      }
    }
    const beforeClause = options.before
      ? `AND (
          created_at > (SELECT created_at FROM git_checkpoints WHERE id = ? AND session_id = ?)
          OR (
            created_at = (SELECT created_at FROM git_checkpoints WHERE id = ? AND session_id = ?)
            AND id > ?
          )
        )`
      : "";
    const params = options.before
      ? [
          sessionId,
          options.before,
          sessionId,
          options.before,
          sessionId,
          options.before,
          options.limit + 1,
        ]
      : [sessionId, options.limit + 1];
    const rows = this.#db
      .query(
        `SELECT
          id,
          session_id AS "sessionId",
          validate_run_id AS "validateRunId",
          commit_hash AS "commitHash",
          commit_message AS "commitMessage",
          created_at AS "createdAt"
        FROM git_checkpoints
        WHERE session_id = ?
        ${beforeClause}
        ORDER BY created_at, rowid
        LIMIT ?`,
      )
      .all(...params) as GitCheckpoint[];
    const checkpoints = rows.slice(0, options.limit);
    return {
      checkpoints,
      nextCursor:
        rows.length > options.limit ? (checkpoints.at(-1)?.id ?? null) : null,
    };
  }
}

export interface MemoryStore {
  insert(memory: Memory): Promise<void>;
  get(id: string, userId: string): Promise<Memory | null>;
  getByName(userId: string, name: string): Promise<Memory | null>;
  listByUser(userId: string, orgId?: string | null): Promise<Memory[]>;
  update(
    id: string,
    userId: string,
    updates: Partial<
      Pick<Memory, "type" | "name" | "description" | "body" | "pinned">
    >,
  ): Promise<Memory | null>;
  upsertByName(memory: Memory): Promise<Memory>;
  delete(id: string, userId: string): Promise<void>;
}

export interface HookRunStore {
  insert(run: HookRun): Promise<void>;
  listBySession(sessionId: string, limit?: number): Promise<HookRun[]>;
}

export interface FileSnapshotTurnSummary {
  turnIndex: number;
  fileCount: number;
  savedAt: string;
}

export interface FileSnapshotDiff {
  filePath: string;
  patch: string;
}

export interface FileSnapshotStore {
  save(snapshot: FileSnapshot): Promise<void>;
  restore(sessionId: string, turnIndex: number): Promise<FileSnapshot[]>;
  listTurns(sessionId: string): Promise<FileSnapshotTurnSummary[]>;
  diff(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
  ): Promise<FileSnapshotDiff[]>;
  evict(sessionId: string, keepTurns: number): Promise<void>;
}

export interface ApprovalRequestStore {
  insert(request: ApprovalRequest): Promise<void>;
  get(id: string): Promise<ApprovalRequest | null>;
  listBySession(sessionId: string): Promise<ApprovalRequest[]>;
  applyDecision(
    id: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalRequest | null>;
}

export interface PermissionStore {
  insertDenial(denial: PermissionDenial): Promise<void>;
  listDenials(sessionId: string): Promise<PermissionDenial[]>;
  insertAllowRule(rule: AllowRule): Promise<void>;
  listAllowRules(
    sessionId?: string | null,
    orgId?: string | null,
  ): Promise<AllowRule[]>;
}

export interface InstalledPluginRecord {
  name: string;
  version: string;
  description: string;
  author: string;
  manifestJson: string;
  installedAt: string;
}

export interface InstalledPluginStore {
  upsert(
    plugin: PluginManifest,
    installedAt: string,
  ): Promise<InstalledPluginRecord>;
  get(name: string): Promise<InstalledPluginRecord | null>;
  list(): Promise<InstalledPluginRecord[]>;
  delete(name: string): Promise<void>;
}

export class SqliteMemoryStore implements MemoryStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async insert(memory: Memory): Promise<void> {
    this.#db
      .query(
        `INSERT INTO memories (
          id, user_id, org_id, type, scope, source, name, description, body, pinned, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.userId,
        memory.orgId,
        memory.type,
        memory.scope ?? "user",
        memory.source ?? "manual",
        memory.name,
        memory.description,
        memory.body,
        Number(memory.pinned),
        memory.createdAt,
        memory.updatedAt,
      );
  }

  async get(id: string, userId: string): Promise<Memory | null> {
    const row = this.#db
      .query(
        `SELECT id, user_id AS "userId", org_id AS "orgId", type, scope, source, name, description,
                body, pinned, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM memories WHERE id = ? AND user_id = ?`,
      )
      .get(id, userId) as MemoryRow | null;
    return row ? toMemory(row) : null;
  }

  async getByName(userId: string, name: string): Promise<Memory | null> {
    const row = this.#db
      .query(
        `SELECT id, user_id AS "userId", org_id AS "orgId", type, scope, source, name, description,
                body, pinned, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM memories WHERE user_id = ? AND name = ?`,
      )
      .get(userId, name) as MemoryRow | null;
    return row ? toMemory(row) : null;
  }

  async listByUser(userId: string, orgId?: string | null): Promise<Memory[]> {
    const rows = this.#db
      .query(
        `SELECT id, user_id AS "userId", org_id AS "orgId", type, scope, source, name, description,
                body, pinned, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM memories
         WHERE user_id = ? ${orgId ? "AND (org_id = ? OR org_id IS NULL)" : ""}
         ORDER BY pinned DESC, updated_at DESC`,
      )
      .all(...(orgId ? [userId, orgId] : [userId])) as MemoryRow[];
    return rows.map(toMemory);
  }

  async update(
    id: string,
    userId: string,
    updates: Partial<
      Pick<Memory, "type" | "name" | "description" | "body" | "pinned">
    >,
  ): Promise<Memory | null> {
    const setClauses: string[] = ["updated_at = ?"];
    const values: unknown[] = [new Date().toISOString()];

    if (updates.type !== undefined) {
      setClauses.push("type = ?");
      values.push(updates.type);
    }
    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push("description = ?");
      values.push(updates.description);
    }
    if (updates.body !== undefined) {
      setClauses.push("body = ?");
      values.push(updates.body);
    }
    if (updates.pinned !== undefined) {
      setClauses.push("pinned = ?");
      values.push(Number(updates.pinned));
    }

    values.push(id, userId);
    this.#db
      .query(
        `UPDATE memories SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
      )
      .run(...(values as (string | number | null)[]));

    return this.get(id, userId);
  }

  async upsertByName(memory: Memory): Promise<Memory> {
    this.#db
      .query(
        `INSERT INTO memories (
          id, user_id, org_id, type, scope, source, name, description, body, pinned, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, name) DO UPDATE SET
          type = excluded.type,
          scope = excluded.scope,
          source = excluded.source,
          description = excluded.description,
          body = excluded.body,
          pinned = excluded.pinned,
          updated_at = excluded.updated_at`,
      )
      .run(
        memory.id,
        memory.userId,
        memory.orgId,
        memory.type,
        memory.scope ?? "user",
        memory.source ?? "manual",
        memory.name,
        memory.description,
        memory.body,
        Number(memory.pinned),
        memory.createdAt,
        memory.updatedAt,
      );
    const result = await this.getByName(memory.userId, memory.name);
    if (!result)
      throw new Error(
        `Memory upsert failed for user=${memory.userId} name=${memory.name}`,
      );
    return result;
  }

  async delete(id: string, userId: string): Promise<void> {
    this.#db
      .query("DELETE FROM memories WHERE id = ? AND user_id = ?")
      .run(id, userId);
  }
}

export class SqliteHookRunStore implements HookRunStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async insert(run: HookRun): Promise<void> {
    this.#db
      .query(
        `INSERT INTO hook_runs (
          id, hook_name, event_type, session_id, blocked, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.hookName,
        run.eventType,
        run.sessionId,
        Number(run.blocked),
        run.durationMs,
        run.createdAt,
      );
  }

  async listBySession(sessionId: string, limit = 100): Promise<HookRun[]> {
    const rows = this.#db
      .query(
        `SELECT id, hook_name AS "hookName", event_type AS "eventType",
                session_id AS "sessionId", blocked, duration_ms AS "durationMs",
                created_at AS "createdAt"
         FROM hook_runs
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as HookRunRow[];
    return rows.map(toHookRun);
  }
}

export class SqliteFileSnapshotStore implements FileSnapshotStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async save(snapshot: FileSnapshot): Promise<void> {
    this.#db
      .query(
        `INSERT OR REPLACE INTO file_snapshots (
          id, session_id, turn_index, file_path, content_hash, content, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.sessionId,
        snapshot.turnIndex,
        snapshot.filePath,
        snapshot.contentHash,
        snapshot.content,
        snapshot.savedAt,
      );
  }

  async restore(sessionId: string, turnIndex: number): Promise<FileSnapshot[]> {
    return this.#db
      .query(
        `SELECT id, session_id AS "sessionId", turn_index AS "turnIndex",
                file_path AS "filePath", content_hash AS "contentHash",
                content, saved_at AS "savedAt"
         FROM file_snapshots
         WHERE session_id = ? AND turn_index = ?
         ORDER BY file_path`,
      )
      .all(sessionId, turnIndex) as FileSnapshot[];
  }

  async listTurns(sessionId: string): Promise<FileSnapshotTurnSummary[]> {
    return this.#db
      .query(
        `SELECT turn_index AS "turnIndex",
                COUNT(*) AS "fileCount",
                MAX(saved_at) AS "savedAt"
         FROM file_snapshots
         WHERE session_id = ?
         GROUP BY turn_index
         ORDER BY turn_index`,
      )
      .all(sessionId) as FileSnapshotTurnSummary[];
  }

  async diff(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
  ): Promise<FileSnapshotDiff[]> {
    return diffSnapshots(
      await this.restore(sessionId, fromTurn),
      await this.restore(sessionId, toTurn),
    );
  }

  async evict(sessionId: string, keepTurns: number): Promise<void> {
    const maxTurnRow = this.#db
      .query(
        "SELECT COALESCE(MAX(turn_index), -1) AS maxTurn FROM file_snapshots WHERE session_id = ?",
      )
      .get(sessionId) as { maxTurn: number } | null;
    const threshold = (maxTurnRow?.maxTurn ?? -1) - keepTurns;
    this.#db
      .query(
        "DELETE FROM file_snapshots WHERE session_id = ? AND turn_index < ?",
      )
      .run(sessionId, threshold);
  }
}

export class SqliteApprovalRequestStore implements ApprovalRequestStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async insert(request: ApprovalRequest): Promise<void> {
    this.#db
      .query(
        `INSERT INTO approval_requests (
          id, session_id, plan_id, plan_content, created_at, expires_at, status, feedback
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.sessionId,
        request.planId,
        request.planContent,
        request.createdAt,
        request.expiresAt,
        request.status,
        request.feedback,
      );
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    return (
      (this.#db
        .query(
          `SELECT id, session_id AS "sessionId", plan_id AS "planId",
                plan_content AS "planContent", created_at AS "createdAt",
                expires_at AS "expiresAt", status, feedback
         FROM approval_requests
         WHERE id = ?`,
        )
        .get(id) as ApprovalRequest | null) ?? null
    );
  }

  async listBySession(sessionId: string): Promise<ApprovalRequest[]> {
    return this.#db
      .query(
        `SELECT id, session_id AS "sessionId", plan_id AS "planId",
                plan_content AS "planContent", created_at AS "createdAt",
                expires_at AS "expiresAt", status, feedback
         FROM approval_requests
         WHERE session_id = ?
         ORDER BY created_at DESC`,
      )
      .all(sessionId) as ApprovalRequest[];
  }

  async applyDecision(
    id: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalRequest | null> {
    this.#db
      .query(
        "UPDATE approval_requests SET status = ?, feedback = ? WHERE id = ?",
      )
      .run(decision.approved ? "approved" : "rejected", decision.feedback, id);
    return this.get(id);
  }
}

export class SqlitePermissionStore implements PermissionStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async insertDenial(denial: PermissionDenial): Promise<void> {
    this.#db
      .query(
        `INSERT INTO permission_denials (
          id, session_id, tool, input, denied_by, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        denial.id,
        denial.sessionId,
        denial.tool,
        JSON.stringify(denial.input),
        denial.deniedBy,
        denial.reason,
        denial.createdAt,
      );
  }

  async listDenials(sessionId: string): Promise<PermissionDenial[]> {
    const rows = this.#db
      .query(
        `SELECT id, session_id AS "sessionId", tool, input,
                denied_by AS "deniedBy", reason, created_at AS "createdAt"
         FROM permission_denials
         WHERE session_id = ?
         ORDER BY created_at DESC`,
      )
      .all(sessionId) as PermissionDenialRow[];
    return rows.map(toPermissionDenial);
  }

  async insertAllowRule(rule: AllowRule): Promise<void> {
    this.#db
      .query(
        `INSERT INTO permission_allow_rules (
          id, session_id, org_id, tool, input_pattern, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rule.id,
        rule.sessionId,
        rule.orgId,
        rule.tool,
        rule.inputPattern,
        rule.createdAt,
      );
  }

  async listAllowRules(
    sessionId?: string | null,
    orgId?: string | null,
  ): Promise<AllowRule[]> {
    const rows = this.#db
      .query(
        `SELECT id, session_id AS "sessionId", org_id AS "orgId", tool,
                input_pattern AS "inputPattern", created_at AS "createdAt"
         FROM permission_allow_rules
         WHERE (session_id IS NULL AND (org_id IS NULL OR org_id = ?))
            OR session_id = ?
         ORDER BY created_at DESC`,
      )
      .all(orgId ?? null, sessionId ?? null) as AllowRule[];
    return rows;
  }
}

export class SqliteInstalledPluginStore implements InstalledPluginStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async upsert(
    plugin: PluginManifest,
    installedAt: string,
  ): Promise<InstalledPluginRecord> {
    const manifestJson = JSON.stringify(plugin);
    this.#db
      .query(
        `INSERT INTO installed_plugins (
          name, version, description, author, manifest_json, installed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          version = excluded.version,
          description = excluded.description,
          author = excluded.author,
          manifest_json = excluded.manifest_json,
          installed_at = excluded.installed_at`,
      )
      .run(
        plugin.name,
        plugin.version,
        plugin.description,
        plugin.author,
        manifestJson,
        installedAt,
      );
    const record = await this.get(plugin.name);
    if (!record) {
      throw new Error(`Installed plugin upsert failed for ${plugin.name}`);
    }
    return record;
  }

  async get(name: string): Promise<InstalledPluginRecord | null> {
    return (
      (this.#db
        .query(
          `SELECT name, version, description, author,
                manifest_json AS "manifestJson",
                installed_at AS "installedAt"
         FROM installed_plugins
         WHERE name = ?`,
        )
        .get(name) as InstalledPluginRecord | null) ?? null
    );
  }

  async list(): Promise<InstalledPluginRecord[]> {
    return this.#db
      .query(
        `SELECT name, version, description, author,
                manifest_json AS "manifestJson",
                installed_at AS "installedAt"
         FROM installed_plugins
         ORDER BY installed_at DESC, name`,
      )
      .all() as InstalledPluginRecord[];
  }

  async delete(name: string): Promise<void> {
    this.#db.query("DELETE FROM installed_plugins WHERE name = ?").run(name);
  }
}

export class AdapterMemoryStore implements MemoryStore {
  constructor(private readonly db: DbAdapter) {}

  async insert(memory: Memory): Promise<void> {
    await this.db.execute(
      `INSERT INTO memories (
        id, user_id, org_id, type, scope, source, name, description, body, pinned, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.id,
        memory.userId,
        memory.orgId,
        memory.type,
        memory.scope ?? "user",
        memory.source ?? "manual",
        memory.name,
        memory.description,
        memory.body,
        Number(memory.pinned),
        memory.createdAt,
        memory.updatedAt,
      ],
    );
  }

  async get(id: string, userId: string): Promise<Memory | null> {
    const row = await this.db.first<MemoryRow>(
      `SELECT id, user_id AS "userId", org_id AS "orgId", type, scope, source, name, description,
              body, pinned, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM memories WHERE id = ? AND user_id = ?`,
      [id, userId],
    );
    return row ? toMemory(row) : null;
  }

  async getByName(userId: string, name: string): Promise<Memory | null> {
    const row = await this.db.first<MemoryRow>(
      `SELECT id, user_id AS "userId", org_id AS "orgId", type, scope, source, name, description,
              body, pinned, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM memories WHERE user_id = ? AND name = ?`,
      [userId, name],
    );
    return row ? toMemory(row) : null;
  }

  async listByUser(userId: string, orgId?: string | null): Promise<Memory[]> {
    const rows = await this.db.query<MemoryRow>(
      `SELECT id, user_id AS "userId", org_id AS "orgId", type, scope, source, name, description,
              body, pinned, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM memories
       WHERE user_id = ? ${orgId ? "AND (org_id = ? OR org_id IS NULL)" : ""}
       ORDER BY pinned DESC, updated_at DESC`,
      orgId ? [userId, orgId] : [userId],
    );
    return rows.map(toMemory);
  }

  async update(
    id: string,
    userId: string,
    updates: Partial<
      Pick<Memory, "type" | "name" | "description" | "body" | "pinned">
    >,
  ): Promise<Memory | null> {
    const setClauses: string[] = ["updated_at = ?"];
    const values: unknown[] = [new Date().toISOString()];

    if (updates.type !== undefined) {
      setClauses.push("type = ?");
      values.push(updates.type);
    }
    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push("description = ?");
      values.push(updates.description);
    }
    if (updates.body !== undefined) {
      setClauses.push("body = ?");
      values.push(updates.body);
    }
    if (updates.pinned !== undefined) {
      setClauses.push("pinned = ?");
      values.push(Number(updates.pinned));
    }

    values.push(id, userId);
    await this.db.execute(
      `UPDATE memories SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
      values,
    );
    return this.get(id, userId);
  }

  async upsertByName(memory: Memory): Promise<Memory> {
    await this.db.execute(
      `INSERT INTO memories (
        id, user_id, org_id, type, scope, source, name, description, body, pinned, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, name) DO UPDATE SET
        type = excluded.type,
        scope = excluded.scope,
        source = excluded.source,
        description = excluded.description,
        body = excluded.body,
        pinned = excluded.pinned,
        updated_at = excluded.updated_at`,
      [
        memory.id,
        memory.userId,
        memory.orgId,
        memory.type,
        memory.scope ?? "user",
        memory.source ?? "manual",
        memory.name,
        memory.description,
        memory.body,
        Number(memory.pinned),
        memory.createdAt,
        memory.updatedAt,
      ],
    );
    const result = await this.getByName(memory.userId, memory.name);
    if (!result)
      throw new Error(
        `Memory upsert failed for user=${memory.userId} name=${memory.name}`,
      );
    return result;
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.db.execute("DELETE FROM memories WHERE id = ? AND user_id = ?", [
      id,
      userId,
    ]);
  }
}

export class AdapterHookRunStore implements HookRunStore {
  constructor(private readonly db: DbAdapter) {}

  async insert(run: HookRun): Promise<void> {
    await this.db.execute(
      `INSERT INTO hook_runs (
        id, hook_name, event_type, session_id, blocked, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.hookName,
        run.eventType,
        run.sessionId,
        Number(run.blocked),
        run.durationMs,
        run.createdAt,
      ],
    );
  }

  async listBySession(sessionId: string, limit = 100): Promise<HookRun[]> {
    const rows = await this.db.query<HookRunRow>(
      `SELECT id, hook_name AS "hookName", event_type AS "eventType",
              session_id AS "sessionId", blocked, duration_ms AS "durationMs",
              created_at AS "createdAt"
       FROM hook_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      [sessionId, limit],
    );
    return rows.map(toHookRun);
  }
}

export class AdapterFileSnapshotStore implements FileSnapshotStore {
  constructor(private readonly db: DbAdapter) {}

  async save(snapshot: FileSnapshot): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO file_snapshots (
        id, session_id, turn_index, file_path, content_hash, content, saved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.id,
        snapshot.sessionId,
        snapshot.turnIndex,
        snapshot.filePath,
        snapshot.contentHash,
        snapshot.content,
        snapshot.savedAt,
      ],
    );
  }

  async restore(sessionId: string, turnIndex: number): Promise<FileSnapshot[]> {
    return this.db.query<FileSnapshot>(
      `SELECT id, session_id AS "sessionId", turn_index AS "turnIndex",
              file_path AS "filePath", content_hash AS "contentHash",
              content, saved_at AS "savedAt"
       FROM file_snapshots
       WHERE session_id = ? AND turn_index = ?
       ORDER BY file_path`,
      [sessionId, turnIndex],
    );
  }

  async listTurns(sessionId: string): Promise<FileSnapshotTurnSummary[]> {
    return this.db.query<FileSnapshotTurnSummary>(
      `SELECT turn_index AS "turnIndex",
              COUNT(*) AS "fileCount",
              MAX(saved_at) AS "savedAt"
       FROM file_snapshots
       WHERE session_id = ?
       GROUP BY turn_index
       ORDER BY turn_index`,
      [sessionId],
    );
  }

  async diff(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
  ): Promise<FileSnapshotDiff[]> {
    return diffSnapshots(
      await this.restore(sessionId, fromTurn),
      await this.restore(sessionId, toTurn),
    );
  }

  async evict(sessionId: string, keepTurns: number): Promise<void> {
    const row = await this.db.first<{ maxTurn: number }>(
      "SELECT COALESCE(MAX(turn_index), -1) AS maxTurn FROM file_snapshots WHERE session_id = ?",
      [sessionId],
    );
    const threshold = (row?.maxTurn ?? -1) - keepTurns;
    await this.db.execute(
      "DELETE FROM file_snapshots WHERE session_id = ? AND turn_index < ?",
      [sessionId, threshold],
    );
  }
}

export class AdapterApprovalRequestStore implements ApprovalRequestStore {
  constructor(private readonly db: DbAdapter) {}

  async insert(request: ApprovalRequest): Promise<void> {
    await this.db.execute(
      `INSERT INTO approval_requests (
        id, session_id, plan_id, plan_content, created_at, expires_at, status, feedback
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.id,
        request.sessionId,
        request.planId,
        request.planContent,
        request.createdAt,
        request.expiresAt,
        request.status,
        request.feedback,
      ],
    );
  }

  async get(id: string): Promise<ApprovalRequest | null> {
    return this.db.first<ApprovalRequest>(
      `SELECT id, session_id AS "sessionId", plan_id AS "planId",
              plan_content AS "planContent", created_at AS "createdAt",
              expires_at AS "expiresAt", status, feedback
       FROM approval_requests
       WHERE id = ?`,
      [id],
    );
  }

  async listBySession(sessionId: string): Promise<ApprovalRequest[]> {
    return this.db.query<ApprovalRequest>(
      `SELECT id, session_id AS "sessionId", plan_id AS "planId",
              plan_content AS "planContent", created_at AS "createdAt",
              expires_at AS "expiresAt", status, feedback
       FROM approval_requests
       WHERE session_id = ?
       ORDER BY created_at DESC`,
      [sessionId],
    );
  }

  async applyDecision(
    id: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalRequest | null> {
    await this.db.execute(
      "UPDATE approval_requests SET status = ?, feedback = ? WHERE id = ?",
      [decision.approved ? "approved" : "rejected", decision.feedback, id],
    );
    return this.get(id);
  }
}

export class AdapterPermissionStore implements PermissionStore {
  constructor(private readonly db: DbAdapter) {}

  async insertDenial(denial: PermissionDenial): Promise<void> {
    await this.db.execute(
      `INSERT INTO permission_denials (
        id, session_id, tool, input, denied_by, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        denial.id,
        denial.sessionId,
        denial.tool,
        JSON.stringify(denial.input),
        denial.deniedBy,
        denial.reason,
        denial.createdAt,
      ],
    );
  }

  async listDenials(sessionId: string): Promise<PermissionDenial[]> {
    const rows = await this.db.query<PermissionDenialRow>(
      `SELECT id, session_id AS "sessionId", tool, input,
              denied_by AS "deniedBy", reason, created_at AS "createdAt"
       FROM permission_denials
       WHERE session_id = ?
       ORDER BY created_at DESC`,
      [sessionId],
    );
    return rows.map(toPermissionDenial);
  }

  async insertAllowRule(rule: AllowRule): Promise<void> {
    await this.db.execute(
      `INSERT INTO permission_allow_rules (
        id, session_id, org_id, tool, input_pattern, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        rule.id,
        rule.sessionId,
        rule.orgId,
        rule.tool,
        rule.inputPattern,
        rule.createdAt,
      ],
    );
  }

  async listAllowRules(
    sessionId?: string | null,
    orgId?: string | null,
  ): Promise<AllowRule[]> {
    return this.db.query<AllowRule>(
      `SELECT id, session_id AS "sessionId", org_id AS "orgId", tool,
              input_pattern AS "inputPattern", created_at AS "createdAt"
       FROM permission_allow_rules
       WHERE (session_id IS NULL AND (org_id IS NULL OR org_id = ?))
          OR session_id = ?
       ORDER BY created_at DESC`,
      [orgId ?? null, sessionId ?? null],
    );
  }
}

export class AdapterInstalledPluginStore implements InstalledPluginStore {
  constructor(private readonly db: DbAdapter) {}

  async upsert(
    plugin: PluginManifest,
    installedAt: string,
  ): Promise<InstalledPluginRecord> {
    const manifestJson = JSON.stringify(plugin);
    await this.db.execute(
      `INSERT INTO installed_plugins (
        name, version, description, author, manifest_json, installed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        version = excluded.version,
        description = excluded.description,
        author = excluded.author,
        manifest_json = excluded.manifest_json,
        installed_at = excluded.installed_at`,
      [
        plugin.name,
        plugin.version,
        plugin.description,
        plugin.author,
        manifestJson,
        installedAt,
      ],
    );
    const record = await this.get(plugin.name);
    if (!record) {
      throw new Error(`Installed plugin upsert failed for ${plugin.name}`);
    }
    return record;
  }

  async get(name: string): Promise<InstalledPluginRecord | null> {
    return this.db.first<InstalledPluginRecord>(
      `SELECT name, version, description, author,
              manifest_json AS "manifestJson",
              installed_at AS "installedAt"
       FROM installed_plugins
       WHERE name = ?`,
      [name],
    );
  }

  async list(): Promise<InstalledPluginRecord[]> {
    return this.db.query<InstalledPluginRecord>(
      `SELECT name, version, description, author,
              manifest_json AS "manifestJson",
              installed_at AS "installedAt"
       FROM installed_plugins
       ORDER BY installed_at DESC, name`,
    );
  }

  async delete(name: string): Promise<void> {
    await this.db.execute("DELETE FROM installed_plugins WHERE name = ?", [
      name,
    ]);
  }
}

type SessionRow = Omit<Session, "config"> & { config: string };
type MemoryRow = Omit<Memory, "pinned"> & { pinned: number };
type HookRunRow = Omit<HookRun, "blocked"> & { blocked: number };
type PermissionDenialRow = Omit<PermissionDenial, "input"> & { input: string };

function toMemory(row: MemoryRow): Memory {
  return { ...row, pinned: Boolean(row.pinned) };
}

function toHookRun(row: HookRunRow): HookRun {
  return { ...row, blocked: Boolean(row.blocked) };
}

function toPermissionDenial(row: PermissionDenialRow): PermissionDenial {
  return {
    ...row,
    input: decodeJson(row.input),
  };
}

type MessageRow = Omit<
  Message,
  "content" | "hasThinking" | "compactionBoundary" | "compactionAnchor"
> & {
  content: string;
  hasThinking: number;
  compactionBoundary: number;
  compactionAnchor: number;
};
type ConversationMessageRow = Omit<
  ConversationMessage,
  "content" | "hasThinking" | "compactionBoundary" | "compactionAnchor"
> & {
  content: string;
  hasThinking: number;
  compactionBoundary: number;
  compactionAnchor: number;
};

function encodeTextContent(content: string): string {
  return JSON.stringify([{ type: "text", text: content }]);
}

function decodeTextContent(content: string): string {
  try {
    const blocks = JSON.parse(content) as Array<{ text?: unknown }>;
    return blocks
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("\n");
  } catch {
    return content;
  }
}

function toMessage(row: MessageRow): Message {
  return {
    ...row,
    content: decodeTextContent(row.content),
    hasThinking: Boolean(row.hasThinking),
    compactionBoundary: Boolean(row.compactionBoundary),
    compactionAnchor: Boolean(row.compactionAnchor),
  };
}

function toConversationMessage(
  row: ConversationMessageRow,
): ConversationMessage {
  return {
    ...row,
    content: decodeContentBlocks(row.content),
    hasThinking: Boolean(row.hasThinking),
    compactionBoundary: Boolean(row.compactionBoundary),
    compactionAnchor: Boolean(row.compactionAnchor),
  };
}

function decodeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function diffSnapshots(
  fromSnapshots: FileSnapshot[],
  toSnapshots: FileSnapshot[],
): FileSnapshotDiff[] {
  const fromMap = new Map(
    fromSnapshots.map((snapshot) => [snapshot.filePath, snapshot]),
  );
  const toMap = new Map(
    toSnapshots.map((snapshot) => [snapshot.filePath, snapshot]),
  );
  const filePaths = new Set([...fromMap.keys(), ...toMap.keys()]);

  return [...filePaths].sort().flatMap((filePath) => {
    const before = fromMap.get(filePath)?.content ?? "";
    const after = toMap.get(filePath)?.content ?? "";

    if (before === after) {
      return [];
    }

    return [
      {
        filePath,
        patch: createPatch(filePath, before, after, "turn-from", "turn-to"),
      },
    ];
  });
}

function decodeContentBlocks(content: string): ConversationContentBlock[] {
  try {
    const parsed = JSON.parse(content) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.filter(isConversationContentBlock);
    }
  } catch {
    // Fall through to the v1 plain-text compatibility shape.
  }

  return [{ type: "text", text: content }];
}

function isConversationContentBlock(
  value: unknown,
): value is ConversationContentBlock {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

import type { DbAdapter } from "./adapter";

export class AdapterSessionStore implements SessionStore {
  constructor(private readonly db: DbAdapter) {}

  async insert(session: Session): Promise<void> {
    await this.db.execute(
      `INSERT INTO sessions (
        id, status, repo_path, container_id, volume_id, config, mode,
        effort, worktree_path, worktree_branch, start_checkpoint_hash,
        parent_session_id, agent_name, agent_color, coordinator_mode,
        user_id, org_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.status,
        session.repoPath,
        session.containerId,
        session.volumeId,
        JSON.stringify(session.config),
        session.mode,
        session.effort,
        session.worktreePath,
        session.worktreeBranch,
        session.startCheckpointHash,
        session.parentSessionId ?? null,
        session.agentName ?? null,
        session.agentColor ?? null,
        Number(session.coordinatorMode ?? false),
        session.userId,
        session.orgId,
        session.createdAt,
        session.updatedAt,
      ],
    );
  }

  async get(sessionId: string, orgId?: string): Promise<Session | null> {
    const row = await this.db.first<SessionRow>(
      `SELECT id, status, repo_path AS "repoPath", container_id AS "containerId",
              volume_id AS "volumeId", config, mode, effort,
              worktree_path AS "worktreePath", worktree_branch AS "worktreeBranch",
              start_checkpoint_hash AS "startCheckpointHash",
              parent_session_id AS "parentSessionId",
              agent_name AS "agentName",
              agent_color AS "agentColor",
              coordinator_mode AS "coordinatorMode",
              user_id AS "userId", org_id AS "orgId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM sessions WHERE id = ? ${orgId ? "AND org_id = ?" : ""}`,
      orgId ? [sessionId, orgId] : [sessionId],
    );
    return row
      ? { ...row, config: JSON.parse(row.config) as Record<string, unknown> }
      : null;
  }

  async update(
    sessionId: string,
    updates: Partial<Pick<Session, "coordinatorMode" | "effort">>,
  ): Promise<Session> {
    const now = new Date().toISOString();
    if (updates.effort !== undefined) {
      await this.db.execute(
        "UPDATE sessions SET effort = ?, updated_at = ? WHERE id = ?",
        [updates.effort, now, sessionId],
      );
    }
    if (updates.coordinatorMode !== undefined) {
      await this.db.execute(
        "UPDATE sessions SET coordinator_mode = ?, updated_at = ? WHERE id = ?",
        [Number(updates.coordinatorMode), now, sessionId],
      );
    }
    const session = await this.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return session;
  }

  async getContextStats(sessionId: string): Promise<ContextStats> {
    const row = await this.db.first<{ total: number; lastTurn: number }>(
      `SELECT
        COALESCE(SUM(token_count), 0) AS total,
        (SELECT COALESCE(token_count, 0) FROM messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1) AS lastTurn
       FROM messages WHERE session_id = ?`,
      [sessionId, sessionId],
    );
    const total = row?.total ?? 0;
    const lastTurnTokens = row?.lastTurn ?? 0;
    return {
      systemPrompt: 0,
      memory: 0,
      repoMap: 0,
      messages: total,
      lastTurnTokens,
      budget: CONTEXT_TOKEN_BUDGET,
      available: Math.max(0, CONTEXT_TOKEN_BUDGET - total),
    };
  }

  async delete(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `DELETE FROM tool_uses WHERE message_id IN (SELECT id FROM messages WHERE session_id = ?)`,
        [sessionId],
      );
      await tx.execute("DELETE FROM git_checkpoints WHERE session_id = ?", [
        sessionId,
      ]);
      await tx.execute("DELETE FROM file_snapshots WHERE session_id = ?", [
        sessionId,
      ]);
      await tx.execute("DELETE FROM permission_denials WHERE session_id = ?", [
        sessionId,
      ]);
      await tx.execute(
        "DELETE FROM permission_allow_rules WHERE session_id = ?",
        [sessionId],
      );
      await tx.execute("DELETE FROM approval_requests WHERE session_id = ?", [
        sessionId,
      ]);
      await tx.execute(
        "DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memories)",
      );
      await tx.execute("DELETE FROM validate_runs WHERE session_id = ?", [
        sessionId,
      ]);
      await tx.execute("DELETE FROM messages WHERE session_id = ?", [
        sessionId,
      ]);
      await tx.execute("DELETE FROM plans WHERE session_id = ?", [sessionId]);
      await tx.execute("DELETE FROM sessions WHERE id = ?", [sessionId]);
    });
  }

  async listByOrg(orgId: string): Promise<Session[]> {
    const rows = await this.db.query<SessionRow>(
      `SELECT id, status, repo_path AS "repoPath", container_id AS "containerId",
              volume_id AS "volumeId", config, mode, effort,
              worktree_path AS "worktreePath", worktree_branch AS "worktreeBranch",
              start_checkpoint_hash AS "startCheckpointHash",
              parent_session_id AS "parentSessionId",
              agent_name AS "agentName",
              agent_color AS "agentColor",
              coordinator_mode AS "coordinatorMode",
              user_id AS "userId", org_id AS "orgId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM sessions WHERE org_id = ? ORDER BY created_at, id`,
      [orgId],
    );
    return rows.map((row) => ({
      ...row,
      config: JSON.parse(row.config) as Record<string, unknown>,
    }));
  }

  async listChildren(): Promise<Session[]> {
    const rows = await this.db.query<SessionRow>(
      `SELECT id, status, repo_path AS "repoPath", container_id AS "containerId",
              volume_id AS "volumeId", config, mode, effort,
              worktree_path AS "worktreePath", worktree_branch AS "worktreeBranch",
              start_checkpoint_hash AS "startCheckpointHash",
              parent_session_id AS "parentSessionId",
              agent_name AS "agentName",
              agent_color AS "agentColor",
              coordinator_mode AS "coordinatorMode",
              user_id AS "userId", org_id AS "orgId",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM sessions WHERE parent_session_id IS NOT NULL ORDER BY created_at, id`,
    );
    return rows.map((row) => ({
      ...row,
      config: JSON.parse(row.config) as Record<string, unknown>,
    }));
  }
}

export class AdapterPIVStore implements PIVStore {
  constructor(private readonly db: DbAdapter) {}

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    await this.db.execute(
      "UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?",
      [status, new Date().toISOString(), sessionId],
    );
  }
  async insertMessage(message: Message): Promise<void> {
    await this.db.execute(
      `INSERT INTO messages (id, session_id, task_id, role, phase, model, content, has_thinking, token_count, compaction_boundary, compaction_anchor, body_compressed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.sessionId,
        message.taskId,
        message.role,
        message.phase,
        message.model,
        encodeTextContent(message.content),
        Number(message.hasThinking),
        message.tokenCount,
        Number(message.compactionBoundary),
        Number(message.compactionAnchor ?? false),
        message.bodyCompressed ?? null,
        message.createdAt,
      ],
    );
  }
  async listMessagesByTask(
    sessionId: string,
    taskId: string,
  ): Promise<Message[]> {
    const rows = await this.db.query<MessageRow>(
      `SELECT id, session_id AS "sessionId", task_id AS "taskId", role, phase, model, content, has_thinking AS "hasThinking", token_count AS "tokenCount", compaction_boundary AS "compactionBoundary", compaction_anchor AS "compactionAnchor", body_compressed AS "bodyCompressed", created_at AS "createdAt" FROM messages WHERE session_id = ? AND task_id = ? ORDER BY created_at, id LIMIT 2000`,
      [sessionId, taskId],
    );
    return rows.map(toMessage);
  }
  async insertPlan(plan: Plan): Promise<void> {
    await this.db.execute(
      `INSERT INTO plans (id, session_id, content, status, feedback, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.id,
        plan.sessionId,
        plan.content,
        plan.status,
        plan.feedback,
        plan.createdAt,
        plan.approvedAt,
      ],
    );
  }
  async getPlan(planId: string): Promise<Plan | null> {
    return this.db.first<Plan>(
      `SELECT id, session_id AS "sessionId", content, status, feedback, created_at AS "createdAt", approved_at AS "approvedAt" FROM plans WHERE id = ?`,
      [planId],
    );
  }
  async getCurrentPlan(sessionId: string): Promise<Plan | null> {
    return this.db.first<Plan>(
      `SELECT id, session_id AS "sessionId", content, status, feedback, created_at AS "createdAt", approved_at AS "approvedAt" FROM plans WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [sessionId],
    );
  }
  async updatePlan(
    planId: string,
    updates: Pick<Plan, "approvedAt" | "feedback" | "status">,
  ): Promise<Plan> {
    await this.db.execute(
      "UPDATE plans SET status = ?, feedback = ?, approved_at = ? WHERE id = ?",
      [updates.status, updates.feedback, updates.approvedAt, planId],
    );
    const plan = await this.getPlan(planId);
    if (!plan) throw new Error(`Unknown plan ${planId}`);
    return plan;
  }
  async insertValidateRun(run: ValidateRun): Promise<void> {
    await this.db.execute(
      `INSERT INTO validate_runs (id, session_id, plan_id, attempt, exit_code, stdout, stderr, passed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.sessionId,
        run.planId,
        run.attempt,
        run.exitCode,
        run.stdout,
        run.stderr,
        Number(run.passed),
        run.createdAt,
      ],
    );
  }
}

export class AdapterConversationStore implements ConversationStore {
  constructor(private readonly db: DbAdapter) {}
  async insert(message: ConversationMessage): Promise<void> {
    await this.db.execute(
      `INSERT INTO messages (id, session_id, task_id, role, phase, model, content, has_thinking, token_count, compaction_boundary, compaction_anchor, body_compressed, created_at) VALUES (?, ?, NULL, ?, 'plan', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.sessionId,
        message.role,
        JSON.stringify(message.content),
        Number(message.hasThinking),
        message.tokenCount,
        Number(message.compactionBoundary),
        Number(message.compactionAnchor ?? false),
        message.bodyCompressed ?? null,
        message.createdAt,
      ],
    );
  }
  async listPage(
    sessionId: string,
    options: { before?: string; limit: number },
    orgId?: string,
  ): Promise<ConversationPage> {
    const tenantClause = orgId
      ? "AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = messages.session_id AND sessions.org_id = ?)"
      : "";
    if (options.before) {
      const cursor = await this.db.first(
        `SELECT 1 AS ok FROM messages
         WHERE id = ? AND session_id = ? AND task_id IS NULL
         ${tenantClause}`,
        orgId
          ? [options.before, sessionId, orgId]
          : [options.before, sessionId],
      );
      if (!cursor) throw new InvalidConversationCursorError(options.before);
    }
    const beforeClause = options.before
      ? `AND (
          created_at < (
            SELECT created_at
            FROM messages
            WHERE id = ? AND session_id = ? AND task_id IS NULL
          )
          OR (
            created_at = (
              SELECT created_at
              FROM messages
              WHERE id = ? AND session_id = ? AND task_id IS NULL
            )
            AND id < ?
          )
        )`
      : "";
    const params = options.before
      ? [
          sessionId,
          ...(orgId ? [orgId] : []),
          options.before,
          sessionId,
          options.before,
          sessionId,
          options.before,
          options.limit + 1,
        ]
      : [sessionId, ...(orgId ? [orgId] : []), options.limit + 1];
    const rows = await this.db.query<ConversationMessageRow>(
      `SELECT id, session_id AS "sessionId", role, content, has_thinking AS "hasThinking", token_count AS "tokenCount", compaction_boundary AS "compactionBoundary", compaction_anchor AS "compactionAnchor", body_compressed AS "bodyCompressed", created_at AS "createdAt" FROM messages WHERE session_id = ? AND task_id IS NULL ${tenantClause} ${beforeClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    );
    const hasMore = rows.length > options.limit;
    const messages = rows
      .slice(0, options.limit)
      .reverse()
      .map(toConversationMessage);
    return { messages, nextCursor: hasMore ? (messages[0]?.id ?? null) : null };
  }
  async listAll(
    sessionId: string,
    orgId?: string,
  ): Promise<ConversationMessage[]> {
    const tenantClause = orgId
      ? "AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = messages.session_id AND sessions.org_id = ?)"
      : "";
    const rows = await this.db.query<ConversationMessageRow>(
      `SELECT id, session_id AS "sessionId", role, content, has_thinking AS "hasThinking", token_count AS "tokenCount", compaction_boundary AS "compactionBoundary", compaction_anchor AS "compactionAnchor", body_compressed AS "bodyCompressed", created_at AS "createdAt" FROM messages WHERE session_id = ? AND task_id IS NULL ${tenantClause} ORDER BY created_at, id`,
      orgId ? [sessionId, orgId] : [sessionId],
    );
    return rows.map(toConversationMessage);
  }
  async deleteAll(sessionId: string, orgId?: string): Promise<void> {
    const tenantClause = orgId
      ? "AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = messages.session_id AND sessions.org_id = ?)"
      : "";
    await this.db.execute(
      `DELETE FROM messages
       WHERE session_id = ? AND task_id IS NULL
       ${tenantClause}`,
      orgId ? [sessionId, orgId] : [sessionId],
    );
  }
}

export class AdapterGitCheckpointStore implements GitCheckpointStore {
  constructor(private readonly db: DbAdapter) {}
  async insert(checkpoint: GitCheckpoint): Promise<void> {
    await this.db.execute(
      `INSERT INTO git_checkpoints (id, session_id, validate_run_id, commit_hash, commit_message, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        checkpoint.id,
        checkpoint.sessionId,
        checkpoint.validateRunId,
        checkpoint.commitHash,
        checkpoint.commitMessage,
        checkpoint.createdAt,
      ],
    );
  }
  async listBySession(
    sessionId: string,
    options: { before?: string; limit: number } = { limit: 50 },
  ): Promise<GitCheckpointPage> {
    if (options.before) {
      const cursor = await this.db.first(
        "SELECT 1 AS ok FROM git_checkpoints WHERE id = ? AND session_id = ?",
        [options.before, sessionId],
      );
      if (!cursor) {
        throw new InvalidCheckpointCursorError(options.before);
      }
    }
    const beforeClause = options.before
      ? `AND (
          created_at > (SELECT created_at FROM git_checkpoints WHERE id = ? AND session_id = ?)
          OR (
            created_at = (SELECT created_at FROM git_checkpoints WHERE id = ? AND session_id = ?)
            AND id > ?
          )
        )`
      : "";
    const params = options.before
      ? [
          sessionId,
          options.before,
          sessionId,
          options.before,
          sessionId,
          options.before,
          options.limit + 1,
        ]
      : [sessionId, options.limit + 1];
    const rows = await this.db.query<GitCheckpoint>(
      `SELECT id, session_id AS "sessionId", validate_run_id AS "validateRunId", commit_hash AS "commitHash", commit_message AS "commitMessage", created_at AS "createdAt" FROM git_checkpoints WHERE session_id = ? ${beforeClause} ORDER BY created_at, id LIMIT ?`,
      params,
    );
    const checkpoints = rows.slice(0, options.limit);
    return {
      checkpoints,
      nextCursor:
        rows.length > options.limit ? (checkpoints.at(-1)?.id ?? null) : null,
    };
  }
}
