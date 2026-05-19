import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ApiToken,
  Organization,
  OrgPlan,
  User,
  UserRole,
} from "@iquantum/types";
import bcrypt from "bcryptjs";
import type { DbAdapter } from "../db/adapter";

interface UserRow extends Record<string, unknown> {
  id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  deletedAt?: string | null;
}

interface OrgRow extends Record<string, unknown> {
  id: string;
  name: string;
  plan: OrgPlan;
  sandboxQuotaHours: number;
  stripeCustomerId: string | null;
  createdAt: string;
}

interface ApiTokenRow extends Record<string, unknown> {
  id: string;
  userId: string;
  name: string;
  scopes: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface InviteRow extends Record<string, unknown> {
  id: string;
  orgId: string;
  email: string;
  role: UserRole;
  tokenHash: string;
  createdByUserId: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface InviteResult {
  id: string;
  token: string;
  email: string;
  role: UserRole;
  expiresAt: string;
}

export interface UserPage {
  members: User[];
  nextCursor: string | null;
}

export class InvalidInviteTokenError extends Error {
  constructor() {
    super("invalid_invite_token");
    this.name = "InvalidInviteTokenError";
  }
}

export class InvalidMemberCursorError extends Error {
  constructor(readonly cursor: string) {
    super("invalid_member_cursor");
    this.name = "InvalidMemberCursorError";
  }
}

export class AuthStore {
  constructor(
    private readonly db: DbAdapter,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async createOrg(name: string, plan: OrgPlan = "free"): Promise<Organization> {
    const org: Organization = {
      id: this.createId(),
      name,
      plan,
      sandboxQuotaHours: 10,
      stripeCustomerId: null,
      createdAt: this.now(),
    };
    await this.db.execute(
      `INSERT INTO organizations (id, name, plan, sandbox_quota_hours, stripe_customer_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        org.id,
        org.name,
        org.plan,
        org.sandboxQuotaHours,
        org.stripeCustomerId,
        org.createdAt,
      ],
    );
    return org;
  }

  async createUser(
    orgId: string,
    email: string,
    password: string,
    role: UserRole,
  ): Promise<User> {
    const user = {
      id: this.createId(),
      orgId,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role,
      createdAt: this.now(),
    };
    await this.db.execute(
      `INSERT INTO users (id, org_id, email, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        user.orgId,
        user.email,
        user.passwordHash,
        user.role,
        user.createdAt,
      ],
    );
    return toUser(user);
  }

  async verifyPassword(email: string, password: string): Promise<User | null> {
    const row = await this.db.first<UserRow>(
      `SELECT id, org_id AS "orgId", email, password_hash AS "passwordHash", role, created_at AS "createdAt"
       FROM users WHERE email = ? AND deleted_at IS NULL`,
      [email],
    );
    if (!row || !(await bcrypt.compare(password, row.passwordHash)))
      return null;
    return toUser(row);
  }

  async createApiToken(
    userId: string,
    name: string,
    scopes: string[],
    expiresAt?: Date,
  ): Promise<{ token: string; record: ApiToken }> {
    const token = randomBytes(32).toString("hex");
    const record: ApiToken = {
      id: this.createId(),
      userId,
      name,
      scopes,
      lastUsedAt: null,
      expiresAt: expiresAt?.toISOString() ?? null,
      revokedAt: null,
      createdAt: this.now(),
    };
    await this.db.execute(
      `INSERT INTO api_tokens (id, user_id, token_hash, name, scopes, last_used_at, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.userId,
        hashToken(token),
        record.name,
        JSON.stringify(record.scopes),
        record.lastUsedAt,
        record.expiresAt,
        record.revokedAt,
        record.createdAt,
      ],
    );
    return { token, record };
  }

  async lookupApiToken(
    rawToken: string,
  ): Promise<{ user: User; org: Organization } | null> {
    const row = await this.db.first<ApiTokenRow & UserRow & OrgRow>(
      `SELECT
         t.id, t.user_id AS "userId", t.name, t.scopes, t.last_used_at AS "lastUsedAt",
         t.expires_at AS "expiresAt", t.revoked_at AS "revokedAt", t.created_at AS "createdAt",
         u.id AS "userRecordId", u.org_id AS "orgId", u.email, u.password_hash AS "passwordHash",
         u.role, u.created_at AS "userCreatedAt",
         o.id AS "orgRecordId", o.name AS "orgName", o.plan, o.sandbox_quota_hours AS "sandboxQuotaHours",
         o.stripe_customer_id AS "stripeCustomerId", o.created_at AS "orgCreatedAt"
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       JOIN organizations o ON o.id = u.org_id
       WHERE t.token_hash = ?
         AND t.revoked_at IS NULL
         AND u.deleted_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > ?)`,
      [hashToken(rawToken), this.now()],
    );
    if (!row) return null;
    if (row.expiresAt && new Date(row.expiresAt) <= new Date()) return null;
    await this.db.execute(
      "UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
      [this.now(), row.id],
    );
    return {
      user: {
        id: String(row.userRecordId),
        orgId: row.orgId,
        email: row.email,
        role: row.role,
        createdAt: String(row.userCreatedAt),
      },
      org: {
        id: String(row.orgRecordId),
        name: String(row.orgName),
        plan: row.plan,
        sandboxQuotaHours: row.sandboxQuotaHours,
        stripeCustomerId: row.stripeCustomerId,
        createdAt: String(row.orgCreatedAt),
      },
    };
  }

  async revokeApiToken(tokenId: string, userId: string): Promise<void> {
    await this.db.execute(
      "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?",
      [this.now(), tokenId, userId],
    );
  }

  async listApiTokens(userId: string): Promise<ApiToken[]> {
    const rows = await this.db.query<ApiTokenRow>(
      `SELECT id, user_id AS "userId", name, scopes, last_used_at AS "lastUsedAt",
              expires_at AS "expiresAt", created_at AS "createdAt"
       FROM api_tokens
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      userId: String(row.userId),
      name: row.name,
      scopes: JSON.parse(row.scopes as unknown as string) as string[],
      lastUsedAt: row.lastUsedAt ?? null,
      expiresAt: row.expiresAt ?? null,
      revokedAt: null,
      createdAt: row.createdAt,
    }));
  }

  async getUser(userId: string): Promise<User> {
    const row = await this.db.first<UserRow>(
      `SELECT id, org_id AS "orgId", email, password_hash AS "passwordHash", role, created_at AS "createdAt"
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [userId],
    );
    if (!row) throw new Error(`Unknown user ${userId}`);
    return toUser(row);
  }

  async listOrgMembersPage(
    orgId: string,
    options: { before?: string; limit: number } = { limit: 50 },
  ): Promise<UserPage> {
    if (options.before) {
      const cursor = await this.db.first(
        `SELECT 1 AS ok FROM users
         WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [options.before, orgId],
      );
      if (!cursor) {
        throw new InvalidMemberCursorError(options.before);
      }
    }

    const beforeClause = options.before
      ? `AND (
          created_at > (SELECT created_at FROM users WHERE id = ? AND org_id = ?)
          OR (
            created_at = (SELECT created_at FROM users WHERE id = ? AND org_id = ?)
            AND id > ?
          )
        )`
      : "";
    const params = options.before
      ? [
          orgId,
          options.before,
          orgId,
          options.before,
          orgId,
          options.before,
          options.limit + 1,
        ]
      : [orgId, options.limit + 1];
    const rows = await this.db.query<UserRow>(
      `SELECT id, org_id AS "orgId", email, password_hash AS "passwordHash", role, created_at AS "createdAt"
       FROM users
       WHERE org_id = ? AND deleted_at IS NULL
       ${beforeClause}
       ORDER BY created_at, id
       LIMIT ?`,
      params,
    );
    const hasMore = rows.length > options.limit;
    const members = rows.slice(0, options.limit).map(toUser);
    return {
      members,
      nextCursor: hasMore ? (members.at(-1)?.id ?? null) : null,
    };
  }

  async listOrgMembers(orgId: string): Promise<User[]> {
    return (await this.listOrgMembersLegacy(orgId)).members;
  }

  async listOrgMembersLegacy(orgId: string): Promise<UserPage> {
    return this.listOrgMembersPage(orgId, { limit: 500 });
  }

  async createInvite(
    orgId: string,
    email: string,
    role: UserRole,
    createdByUserId: string,
  ): Promise<InviteResult> {
    const token = randomBytes(32).toString("base64url");
    const invite: InviteRow = {
      id: this.createId(),
      orgId,
      email,
      role,
      tokenHash: hashToken(token),
      createdByUserId,
      expiresAt: new Date(
        new Date(this.now()).getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      acceptedAt: null,
      createdAt: this.now(),
    };
    await this.db.execute(
      `INSERT INTO invite_tokens (
        id, org_id, email, role, token_hash, created_by_user_id, expires_at, accepted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invite.id,
        invite.orgId,
        invite.email,
        invite.role,
        invite.tokenHash,
        invite.createdByUserId,
        invite.expiresAt,
        invite.acceptedAt,
        invite.createdAt,
      ],
    );
    return {
      id: invite.id,
      token,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
    };
  }

  async acceptInvite(token: string, password: string): Promise<User> {
    // Pre-check outside the write transaction: fail fast for invalid/expired tokens
    // before spending CPU on bcrypt. The write transaction re-checks for double-accept safety.
    const preCheck = await this.db.first(
      `SELECT 1 AS ok FROM invite_tokens
       WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?`,
      [hashToken(token), this.now()],
    );
    if (!preCheck) {
      throw new InvalidInviteTokenError();
    }

    const passwordHash = await bcrypt.hash(password, 12);
    return this.db.transaction(async (tx) => {
      const invite = await tx.first<InviteRow>(
        `SELECT id, org_id AS "orgId", email, role, token_hash AS "tokenHash",
                created_by_user_id AS "createdByUserId", expires_at AS "expiresAt",
                accepted_at AS "acceptedAt", created_at AS "createdAt"
         FROM invite_tokens
         WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?`,
        [hashToken(token), this.now()],
      );
      if (!invite) {
        throw new InvalidInviteTokenError();
      }

      const user = {
        id: this.createId(),
        orgId: invite.orgId,
        email: invite.email,
        passwordHash,
        role: invite.role,
        createdAt: this.now(),
        deletedAt: null,
      };
      await tx.execute(
        `INSERT INTO users (id, org_id, email, password_hash, role, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.orgId,
          user.email,
          user.passwordHash,
          user.role,
          user.createdAt,
          user.deletedAt,
        ],
      );
      await tx.execute(
        "UPDATE invite_tokens SET accepted_at = ? WHERE id = ?",
        [this.now(), invite.id],
      );
      return toUser(user);
    });
  }

  async eraseUser(userId: string): Promise<void> {
    const replacementHash = await bcrypt.hash(
      randomBytes(32).toString("hex"),
      12,
    );
    await this.db.transaction(async (tx) => {
      const deletedAt = this.now();
      await tx.execute(
        "UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        [deletedAt, userId],
      );
      await tx.execute(
        `UPDATE users
         SET email = ?, password_hash = ?, deleted_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
        [
          `deleted-${userId}@deleted.invalid`,
          replacementHash,
          deletedAt,
          userId,
        ],
      );
    });
  }

  async getOrgUsage(
    orgId: string,
    since: Date,
  ): Promise<{ containerMinutes: number }> {
    const row = await this.db.first<{ total: number | null }>(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM billing_events
       WHERE org_id = ? AND event_type = 'container_minute' AND created_at >= ?`,
      [orgId, since.toISOString()],
    );
    return { containerMinutes: Number(row?.total ?? 0) };
  }

  async getOrg(orgId: string): Promise<Organization> {
    const row = await this.db.first<OrgRow>(
      `SELECT id, name, plan, sandbox_quota_hours AS "sandboxQuotaHours",
              stripe_customer_id AS "stripeCustomerId", created_at AS "createdAt"
       FROM organizations WHERE id = ?`,
      [orgId],
    );
    if (!row) throw new Error(`Unknown org ${orgId}`);
    return row;
  }

  async updateOrgPlanByStripeCustomer(
    stripeCustomerId: string,
    plan: OrgPlan,
    sandboxQuotaHours: number,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE organizations
       SET plan = ?, sandbox_quota_hours = ?
       WHERE stripe_customer_id = ?`,
      [plan, sandboxQuotaHours, stripeCustomerId],
    );
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
