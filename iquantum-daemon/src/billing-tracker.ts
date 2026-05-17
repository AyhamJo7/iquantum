import { randomUUID } from "node:crypto";
import type { DbAdapter } from "./db/adapter";
import { logger } from "./logger";
import type { StripeClient } from "./stripe-client";

export class QuotaExceededError extends Error {
  constructor(readonly orgId: string) {
    super(`Sandbox quota exceeded for org ${orgId}`);
    this.name = "QuotaExceededError";
  }
}

export class UnknownOrganizationError extends Error {
  constructor(readonly orgId: string) {
    super(`Unknown organization ${orgId}`);
    this.name = "UnknownOrganizationError";
  }
}

export class BillingTracker {
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly db: DbAdapter,
    private readonly stripe: StripeClient | null,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async onContainerStart(sessionId: string, orgId: string): Promise<void> {
    await this.#insertEvent(sessionId, orgId, "container_start", 1);
    this.#timers.set(
      sessionId,
      setInterval(() => {
        void this.#recordMinute(sessionId, orgId).catch((error) => {
          logger.error({
            msg: "failed to record billing minute",
            sessionId,
            orgId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 60_000),
    );
  }

  async onContainerStop(sessionId: string): Promise<void> {
    const timer = this.#timers.get(sessionId);
    if (timer) clearInterval(timer);
    this.#timers.delete(sessionId);
  }

  async checkQuota(orgId: string): Promise<void> {
    const monthStart = new Date(
      Date.UTC(this.now().getUTCFullYear(), this.now().getUTCMonth(), 1),
    );
    const usage = await this.db.first<{ used: number; quota: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN b.event_type = 'container_minute' AND b.created_at >= ? THEN b.quantity ELSE 0 END), 0) AS used,
         o.sandbox_quota_hours * 60 AS quota
       FROM organizations o
       LEFT JOIN billing_events b ON b.org_id = o.id
       WHERE o.id = ?
       GROUP BY o.id, o.sandbox_quota_hours`,
      [monthStart.toISOString(), orgId],
    );
    if (!usage) {
      throw new UnknownOrganizationError(orgId);
    }
    if (Number(usage.used) >= Number(usage.quota)) {
      throw new QuotaExceededError(orgId);
    }
  }

  async #recordMinute(sessionId: string, orgId: string): Promise<void> {
    await this.#insertEvent(sessionId, orgId, "container_minute", 1);
    const org = await this.db.first<{ stripeCustomerId: string | null }>(
      "SELECT stripe_customer_id AS stripeCustomerId FROM organizations WHERE id = ?",
      [orgId],
    );
    if (org?.stripeCustomerId) {
      await this.stripe?.reportUsage(org.stripeCustomerId, 1);
    }
  }

  async #insertEvent(
    sessionId: string,
    orgId: string,
    eventType: "container_start" | "container_minute" | "token_call",
    quantity: number,
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO billing_events (id, org_id, session_id, event_type, quantity, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        this.createId(),
        orgId,
        sessionId,
        eventType,
        quantity,
        this.now().toISOString(),
      ],
    );
  }
}
