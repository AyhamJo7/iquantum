import { describe, expect, it } from "vitest";
import type { DbAdapter } from "../db/adapter";
import { AuthStore, InvalidInviteTokenError } from "./auth-store";

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

  it("creates expiring invite tokens and accepts them once", async () => {
    const store = new AuthStore(
      new MemoryAuthDb(),
      () => "2026-05-17T00:00:00.000Z",
      idFactory(),
    );
    const org = await store.createOrg("Acme");
    const owner = await store.createUser(
      org.id,
      "owner@example.com",
      "password123",
      "owner",
    );

    const invite = await store.createInvite(
      org.id,
      "new@example.com",
      "member",
      owner.id,
    );
    const user = await store.acceptInvite(invite.token, "password123");

    expect(invite).toMatchObject({
      id: "id-3",
      email: "new@example.com",
      role: "member",
    });
    expect(invite).not.toHaveProperty("password");
    expect(user).toMatchObject({ email: "new@example.com", role: "member" });
    await expect(
      store.verifyPassword("new@example.com", "password123"),
    ).resolves.toMatchObject({ id: user.id });
    await expect(
      store.acceptInvite(invite.token, "password123"),
    ).rejects.toThrow(InvalidInviteTokenError);
  });

  it("erases user PII and revokes API tokens", async () => {
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
    const token = await store.createApiToken(user.id, "cli", []);

    await store.eraseUser(user.id);

    await expect(
      store.verifyPassword("a@example.com", "password123"),
    ).resolves.toBeNull();
    await expect(store.lookupApiToken(token.token)).resolves.toBeNull();
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
  readonly invites: Record<string, unknown>[] = [];
  lastApiTokenLookupSql = "";

  async query<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (sql.includes("FROM users WHERE org_id")) {
      return this.users.filter(
        (u) => u.orgId === params[0] && !u.deletedAt,
      ) as T[];
    }
    return [];
  }

  async first<T extends object>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    if (sql.includes("FROM users WHERE email")) {
      return (
        (this.users.find((u) => u.email === params[0] && !u.deletedAt) as
          | T
          | undefined) ?? null
      );
    }
    if (sql.includes("FROM invite_tokens")) {
      return (
        (this.invites.find(
          (i) =>
            i.tokenHash === params[0] &&
            i.acceptedAt === null &&
            String(i.expiresAt) > String(params[1] ?? ""),
        ) as T | undefined) ?? null
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
      const user = this.users.find(
        (u) => u.id === token.userId && !u.deletedAt,
      );
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
        (this.users.find((u) => u.id === params[0] && !u.deletedAt) as
          | T
          | undefined) ?? null
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
        deletedAt: params[6] ?? null,
      });
    } else if (sql.includes("INSERT INTO invite_tokens")) {
      this.invites.push({
        id: params[0],
        orgId: params[1],
        email: params[2],
        role: params[3],
        tokenHash: params[4],
        createdByUserId: params[5],
        expiresAt: params[6],
        acceptedAt: params[7],
        createdAt: params[8],
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
      if (sql.includes("WHERE user_id")) {
        for (const token of this.tokens.filter((t) => t.userId === params[1])) {
          token.revokedAt = params[0];
        }
      } else {
        const token = this.tokens.find(
          (t) => t.id === params[1] && t.userId === params[2],
        );
        if (token) token.revokedAt = params[0];
      }
    } else if (sql.includes("UPDATE invite_tokens SET accepted_at")) {
      const invite = this.invites.find((i) => i.id === params[1]);
      if (invite) invite.acceptedAt = params[0];
    } else if (sql.includes("UPDATE users")) {
      const user = this.users.find((u) => u.id === params[3]);
      if (user) {
        user.email = params[0];
        user.passwordHash = params[1];
        user.deletedAt = params[2];
      }
    }
  }

  async transaction<T>(fn: (db: DbAdapter) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {}
}
