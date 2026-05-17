import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BillingTracker,
  QuotaExceededError,
  UnknownOrganizationError,
} from "./billing-tracker";

describe("BillingTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows orgs that remain under quota", async () => {
    const tracker = new BillingTracker(
      {
        async first() {
          return { used: 59, quota: 60 };
        },
      } as never,
      null,
      () => new Date("2026-05-17T00:00:00.000Z"),
    );

    await expect(tracker.checkQuota("org-1")).resolves.toBeUndefined();
  });

  it("blocks orgs at quota", async () => {
    const tracker = new BillingTracker(
      {
        async first() {
          return { used: 60, quota: 60 };
        },
        async execute() {},
      } as never,
      null,
      () => new Date("2026-05-17T00:00:00.000Z"),
    );
    await expect(tracker.checkQuota("org-1")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("records container starts", async () => {
    const events: unknown[][] = [];
    const tracker = new BillingTracker(
      {
        async execute(_sql: string, params: unknown[]) {
          events.push(params);
        },
        async first() {
          return { used: 0, quota: 60 };
        },
      } as never,
      null,
      () => new Date("2026-05-17T00:00:00.000Z"),
      () => "event-1",
    );
    await tracker.onContainerStart("session-1", "org-1");
    await tracker.onContainerStop("session-1");
    expect(events[0]).toEqual([
      "event-1",
      "org-1",
      "session-1",
      "container_start",
      1,
      "2026-05-17T00:00:00.000Z",
    ]);
  });

  it("records one container-minute event per timer tick", async () => {
    vi.useFakeTimers();
    const events: unknown[][] = [];
    const tracker = new BillingTracker(
      {
        async execute(_sql: string, params: unknown[]) {
          events.push(params);
        },
        async first() {
          return null;
        },
      } as never,
      null,
      () => new Date("2026-05-17T00:00:00.000Z"),
      () => `event-${events.length + 1}`,
    );

    await tracker.onContainerStart("session-1", "org-1");
    await vi.advanceTimersByTimeAsync(60_000);
    await tracker.onContainerStop("session-1");

    expect(events.map((event) => event[3])).toEqual([
      "container_start",
      "container_minute",
    ]);
  });

  it("blocks unknown orgs instead of bypassing quota checks", async () => {
    const tracker = new BillingTracker(
      {
        async first() {
          return null;
        },
      } as never,
      null,
      () => new Date("2026-05-17T00:00:00.000Z"),
    );

    await expect(tracker.checkQuota("org-missing")).rejects.toBeInstanceOf(
      UnknownOrganizationError,
    );
  });
});
