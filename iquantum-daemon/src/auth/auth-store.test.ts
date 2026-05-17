import { describe, expect, it } from "vitest";
import type { DbAdapter } from "../db/adapter";
import { AuthStore } from "./auth-store";

describe("AuthStore", () => {
  it("creates users and verifies passwords", async () => {
    const store = new AuthStore(
      new MemoryAuthDb(),
      () => "2026-05-17T00:00:00.000Z",
      idFactory(),
    );
    const org = await store.createOrg("Acme");
    const user = await store.createUser(
      org.id,
      "a@example.com",
      "password123",
      "owner",
    );
    await expect(
      store.verifyPassword("a@example.com", "password123"),
    ).resolves.toEqual(user);
    await expect(
      store.verifyPassword("a@example.com", "wrong"),
    ).resolves.toBeNull();
  });

  it("creates, resolves, and revokes API tokens", async () => {
    const store = new AuthStore(
      new MemoryAuthDb(),
      () => "2026-05-17T00:00:00.000Z",
      idFactory(),
    );
    const org = await store.createOrg("Acme");
    const user = await store.createUser(
      org.id,
      "a@example.com",
      "password123",
      "owner",
    );
    const created = await store.createApiToken(user.id, "cli", [
      "sessions:write",
    ]);
    await expect(store.lookupApiToken(created.token)).resolves.toMatchObject({
      user,
      org,
    });
    await store.revokeApiToken(created.record.id, user.id);
    await expect(store.lookupApiToken(created.token)).resolves.toBeNull();
  });

  it("filters expired API tokens in the lookup query", async () => {
    const db = new MemoryAuthDb();
    const store = new AuthStore(
      db,
      () => "2026-05-17T00:00:00.000Z",
      idFactory(),
    );
    const org = await store.createOrg("Acme");
    const user = await store.createUser(
      org.id,
      "a@example.com",
      "password123",
      "owner",
    );
    const created = await store.createApiToken(
      user.id,
      "expired",
      ["sessions:read"],
      new Date("2026-05-16T00:00:00.000Z"),
    );

    await expect(store.lookupApiToken(created.token)).resolves.toBeNull();
    expect(db.lastApiTokenLookupSql).toContain("t.expires_at > ?");
  });
});

function idFactory() {
  let next = 0;
  return () => `id-${++next}`;
}

class MemoryAuthDb implements DbAdapter {
  readonly orgs: Record<string, unknown>[] = [];
  readonly users: Record<string, unknown>[] = [];
  readonly tokens: Record<string, unknown>[] = [];
  lastApiTokenLookupSql = "";

  async query<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (sql.includes("FROM users WHERE org_id")) {
      return this.users.filter((u) => u.orgId === params[0]) as T[];
    }
    return [];
  }

  async first<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    if (sql.includes("FROM users WHERE email")) {
      return (
        (this.users.find((u) => u.email === params[0]) as T | undefined) ?? null
      );
    }
    if (sql.includes("FROM api_tokens t")) {
      this.lastApiTokenLookupSql = sql;
      const token = this.tokens.find(
        (t) =>
          t.tokenHash === params[0] &&
          t.revokedAt === null &&
          (t.expiresAt === null ||
            String(t.expiresAt) > String(params[1] ?? "")),
      );
      if (!token) return null;
      const user = this.users.find((u) => u.id === token.userId);
      const org = this.orgs.find((o) => o.id === user?.orgId);
      return {
        ...token,
        userRecordId: user?.id,
        orgId: user?.orgId,
        email: user?.email,
        passwordHash: user?.passwordHash,
        role: user?.role,
        userCreatedAt: user?.createdAt,
        orgRecordId: org?.id,
        orgName: org?.name,
        plan: org?.plan,
        sandboxQuotaHours: org?.sandboxQuotaHours,
        stripeCustomerId: org?.stripeCustomerId,
        orgCreatedAt: org?.createdAt,
      } as unknown as T;
    }
    if (sql.includes("FROM users WHERE id")) {
      return (
        (this.users.find((u) => u.id === params[0]) as T | undefined) ?? null
      );
    }
    if (sql.includes("FROM organizations WHERE id")) {
      return (
        (this.orgs.find((o) => o.id === params[0]) as T | undefined) ?? null
      );
    }
    return null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.includes("INSERT INTO organizations")) {
      this.orgs.push({
        id: params[0],
        name: params[1],
        plan: params[2],
        sandboxQuotaHours: params[3],
        stripeCustomerId: params[4],
        createdAt: params[5],
      });
    } else if (sql.includes("INSERT INTO users")) {
      this.users.push({
        id: params[0],
        orgId: params[1],
        email: params[2],
        passwordHash: params[3],
        role: params[4],
        createdAt: params[5],
      });
    } else if (sql.includes("INSERT INTO api_tokens")) {
      this.tokens.push({
        id: params[0],
        userId: params[1],
        tokenHash: params[2],
        name: params[3],
        scopes: params[4],
        lastUsedAt: params[5],
        expiresAt: params[6],
        revokedAt: params[7],
        createdAt: params[8],
      });
    } else if (sql.includes("UPDATE api_tokens SET revoked_at")) {
      const token = this.tokens.find(
        (t) => t.id === params[1] && t.userId === params[2],
      );
      if (token) token.revokedAt = params[0];
    }
  }

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}
