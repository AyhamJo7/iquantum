import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { JwtService } from "./jwt-service";

describe("JwtService", () => {
  it("signs and verifies tokens", async () => {
    const service = new JwtService("x".repeat(32));
    const token = await service.sign({
      userId: "u1",
      orgId: "o1",
      role: "owner",
    });
    await expect(service.verify(token)).resolves.toEqual({
      userId: "u1",
      orgId: "o1",
      role: "owner",
    });
  });

  it("returns null for tampered tokens", async () => {
    const service = new JwtService("x".repeat(32));
    const token = await service.sign({
      userId: "u1",
      orgId: "o1",
      role: "member",
    });
    await expect(service.verify(`${token}x`)).resolves.toBeNull();
  });

  it("returns null for expired tokens", async () => {
    const service = new JwtService("x".repeat(32));
    const expired = await new SignJWT({
      userId: "u1",
      orgId: "o1",
      role: "member",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(0)
      .setExpirationTime(1)
      .sign(new TextEncoder().encode("x".repeat(32)));

    await expect(service.verify(expired)).resolves.toBeNull();
  });
});
