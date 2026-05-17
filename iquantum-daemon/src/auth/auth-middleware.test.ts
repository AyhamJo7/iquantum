import { describe, expect, it } from "vitest";
import { authMiddleware } from "./auth-middleware";
import { JwtService } from "./jwt-service";

describe("authMiddleware", () => {
  it("accepts JWTs and API tokens", async () => {
    const jwt = new JwtService("x".repeat(32));
    const token = await jwt.sign({
      userId: "u1",
      orgId: "o1",
      role: "owner",
    });
    const store = {
      async lookupApiToken(raw: string) {
        return raw === "api-token"
          ? { user: { id: "u2", role: "member" }, org: { id: "o2" } }
          : null;
      },
    } as never;
    await expect(
      authMiddleware(
        new Request("http://x", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        store,
        jwt,
      ),
    ).resolves.toEqual({ userId: "u1", orgId: "o1", role: "owner" });
    await expect(
      authMiddleware(
        new Request("http://x", {
          headers: { Authorization: "Bearer api-token" },
        }),
        store,
        jwt,
      ),
    ).resolves.toEqual({ userId: "u2", orgId: "o2", role: "member" });
  });

  it("rejects missing auth", async () => {
    const jwt = new JwtService("x".repeat(32));
    await expect(
      authMiddleware(
        new Request("http://x"),
        { lookupApiToken: async () => null } as never,
        jwt,
      ),
    ).resolves.toBeNull();
  });
});
