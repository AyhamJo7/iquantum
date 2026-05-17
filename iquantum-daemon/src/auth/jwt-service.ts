import type { UserRole } from "@iquantum/types";
import { jwtVerify, SignJWT } from "jose";

export class JwtService {
  readonly #secret: Uint8Array;

  constructor(secret: string) {
    this.#secret = new TextEncoder().encode(secret);
  }

  async sign(payload: {
    userId: string;
    orgId: string;
    role: UserRole;
  }): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(this.#secret);
  }

  async verify(
    token: string,
  ): Promise<{ userId: string; orgId: string; role: UserRole } | null> {
    try {
      const { payload } = await jwtVerify(token, this.#secret);
      if (
        typeof payload.userId !== "string" ||
        typeof payload.orgId !== "string" ||
        (payload.role !== "owner" && payload.role !== "member")
      ) {
        return null;
      }
      return {
        userId: payload.userId,
        orgId: payload.orgId,
        role: payload.role,
      };
    } catch {
      return null;
    }
  }
}
