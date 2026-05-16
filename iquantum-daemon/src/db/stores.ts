import type { Database } from "bun:sqlite";
import type { GitCheckpointStore } from "@iquantum/git";
import type { PIVStore } from "@iquantum/piv-engine";
import type {
  GitCheckpoint,
  Message,
  Plan,
  Session,
  SessionStatus,
  ValidateRun,
} from "@iquantum/types";

export interface SessionStore {
  insert(session: Session): Promise<void>;
  get(sessionId: string): Promise<Session | null>;
  delete(sessionId: string): Promise<void>;
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
  ): Promise<ConversationPage>;
  listAll(sessionId: string): Promise<ConversationMessage[]>;
  deleteAll(sessionId: string): Promise<void>;
}

export class InvalidConversationCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Unknown conversation cursor ${cursor}`);
    this.name = "InvalidConversationCursorError";
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
          id, status, repo_path, container_id, volume_id, config, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.status,
        session.repoPath,
        session.containerId,
        session.volumeId,
        JSON.stringify(session.config),
        session.createdAt,
        session.updatedAt,
      );
  }

  async get(sessionId: string): Promise<Session | null> {
    const row = this.#db
      .query(
        `SELECT
          id,
          status,
          repo_path AS repoPath,
          container_id AS containerId,
          volume_id AS volumeId,
          config,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM sessions
        WHERE id = ?`,
      )
      .get(sessionId) as SessionRow | null;

    if (!row) {
      return null;
    }

    return {
      ...row,
      config: JSON.parse(row.config) as Record<string, unknown>,
    };
  }

  async delete(sessionId: string): Promise<void> {
    this.#db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
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
          has_thinking, token_count, compaction_boundary, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          session_id AS sessionId,
          task_id AS taskId,
          role,
          phase,
          model,
          content,
          has_thinking AS hasThinking,
          token_count AS tokenCount,
          compaction_boundary AS compactionBoundary,
          created_at AS createdAt
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
          session_id AS sessionId,
          content,
          status,
          feedback,
          created_at AS createdAt,
          approved_at AS approvedAt
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
          session_id AS sessionId,
          content,
          status,
          feedback,
          created_at AS createdAt,
          approved_at AS approvedAt
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
          has_thinking, token_count, compaction_boundary, created_at
        ) VALUES (?, ?, NULL, ?, 'plan', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        JSON.stringify(message.content),
        Number(message.hasThinking),
        message.tokenCount,
        Number(message.compactionBoundary),
        message.createdAt,
      );
  }

  async listPage(
    sessionId: string,
    options: { before?: string; limit: number },
  ): Promise<ConversationPage> {
    if (options.before) {
      const cursor = this.#db
        .query(
          "SELECT 1 FROM messages WHERE id = ? AND session_id = ? AND task_id IS NULL",
        )
        .get(options.before, sessionId);

      if (!cursor) {
        throw new InvalidConversationCursorError(options.before);
      }
    }

    const beforeClause = options.before
      ? "AND rowid < (SELECT rowid FROM messages WHERE id = ? AND session_id = ? AND task_id IS NULL)"
      : "";
    const params = options.before
      ? [sessionId, options.before, sessionId, options.limit + 1]
      : [sessionId, options.limit + 1];
    const rows = this.#db
      .query(
        `SELECT
          id,
          session_id AS sessionId,
          role,
          content,
          has_thinking AS hasThinking,
          token_count AS tokenCount,
          compaction_boundary AS compactionBoundary,
          created_at AS createdAt
        FROM messages
        WHERE session_id = ? AND task_id IS NULL
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

  async listAll(sessionId: string): Promise<ConversationMessage[]> {
    const rows = this.#db
      .query(
        `SELECT
          id,
          session_id AS sessionId,
          role,
          content,
          has_thinking AS hasThinking,
          token_count AS tokenCount,
          compaction_boundary AS compactionBoundary,
          created_at AS createdAt
        FROM messages
        WHERE session_id = ? AND task_id IS NULL
        ORDER BY rowid`,
      )
      .all(sessionId) as ConversationMessageRow[];

    return rows.map(toConversationMessage);
  }

  async deleteAll(sessionId: string): Promise<void> {
    this.#db
      .query("DELETE FROM messages WHERE session_id = ? AND task_id IS NULL")
      .run(sessionId);
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

  async listBySession(sessionId: string): Promise<GitCheckpoint[]> {
    return this.#db
      .query(
        `SELECT
          id,
          session_id AS sessionId,
          validate_run_id AS validateRunId,
          commit_hash AS commitHash,
          commit_message AS commitMessage,
          created_at AS createdAt
        FROM git_checkpoints
        WHERE session_id = ?
        ORDER BY created_at, rowid
        LIMIT 500`,
      )
      .all(sessionId) as GitCheckpoint[];
  }
}

type SessionRow = Omit<Session, "config"> & { config: string };
type MessageRow = Omit<
  Message,
  "content" | "hasThinking" | "compactionBoundary"
> & {
  content: string;
  hasThinking: number;
  compactionBoundary: number;
};
type ConversationMessageRow = Omit<
  ConversationMessage,
  "content" | "hasThinking" | "compactionBoundary"
> & {
  content: string;
  hasThinking: number;
  compactionBoundary: number;
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
  };
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
