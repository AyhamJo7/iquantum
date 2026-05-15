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
          id, session_id, role, phase, model, content, token_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.phase,
        message.model,
        message.content,
        message.tokenCount,
        message.createdAt,
      );
  }

  async listMessagesBySession(sessionId: string): Promise<Message[]> {
    return this.#db
      .query(
        `SELECT
          id,
          session_id AS sessionId,
          role,
          phase,
          model,
          content,
          token_count AS tokenCount,
          created_at AS createdAt
        FROM messages
        WHERE session_id = ?
        ORDER BY created_at, rowid`,
      )
      .all(sessionId) as Message[];
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
        ORDER BY created_at, rowid`,
      )
      .all(sessionId) as GitCheckpoint[];
  }
}

type SessionRow = Omit<Session, "config"> & { config: string };
