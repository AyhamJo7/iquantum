import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ApiToken,
  Organization,
  OrgPlan,
  User,
  UserRole,
} from "@iquantum/types";
import bcrypt from "bcrypt";
import type { DbAdapter } from "../db/adapter";

interface UserRow extends Record<string, unknown> {
  id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
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
       FROM users WHERE email = ?`,
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

  async getUser(userId: string): Promise<User> {
    const row = await this.db.first<UserRow>(
      `SELECT id, org_id AS "orgId", email, password_hash AS "passwordHash", role, created_at AS "createdAt"
       FROM users WHERE id = ?`,
      [userId],
    );
    if (!row) throw new Error(`Unknown user ${userId}`);
    return toUser(row);
  }

  async listOrgMembers(orgId: string): Promise<User[]> {
    const rows = await this.db.query<UserRow>(
      `SELECT id, org_id AS "orgId", email, password_hash AS "passwordHash", role, created_at AS "createdAt"
       FROM users WHERE org_id = ? ORDER BY created_at, id`,
      [orgId],
    );
    return rows.map(toUser);
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
