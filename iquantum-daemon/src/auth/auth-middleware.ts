import type { UserRole } from "@iquantum/types";
import type { AuthStore } from "./auth-store";
import type { JwtService } from "./jwt-service";

export interface AuthContext {
  userId: string;
  orgId: string;
  role: UserRole;
}

export async function authMiddleware(
  req: Request,
  authStore: AuthStore,
  jwtService: JwtService,
): Promise<AuthContext | null> {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);

  const jwtPayload = await jwtService.verify(token);
  if (jwtPayload) return jwtPayload;

  const result = await authStore.lookupApiToken(token);
  if (!result) return null;
  return {
    userId: result.user.id,
    orgId: result.org.id,
    role: result.user.role,
  };
}
