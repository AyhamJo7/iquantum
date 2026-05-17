import { describe, expect, it } from "vitest";
import { ensureDaemonReady } from "./startup";

describe("ensureDaemonReady", () => {
  it("returns immediately when the daemon is already healthy", async () => {
    let launches = 0;

    await ensureDaemonReady(
      {
        async health() {
          return { ok: true };
        },
      },
      async () => {
        launches += 1;
      },
      async () => undefined,
    );

    expect(launches).toBe(0);
  });

  it("starts the daemon and polls until it becomes healthy", async () => {
    let checks = 0;
    let launches = 0;
    const sleeps: number[] = [];

    await ensureDaemonReady(
      {
        async health() {
          checks += 1;

          if (checks < 3) {
            throw new Error("connect ENOENT");
          }

          return { ok: true };
        },
      },
      async () => {
        launches += 1;
      },
      async (delayMs: number) => {
        sleeps.push(delayMs);
      },
      { attempts: 3, pollIntervalMs: 200 },
    );

    expect(launches).toBe(1);
    expect(sleeps).toEqual([200, 200]);
  });

  it("fails after the configured startup window", async () => {
    await expect(
      ensureDaemonReady(
        {
          async health() {
            throw new Error("connect ECONNREFUSED");
          },
        },
        async () => undefined,
        async () => undefined,
        { attempts: 2, pollIntervalMs: 1 },
      ),
    ).rejects.toThrow("daemon did not become ready");
  });

  it("treats Bun's missing Unix socket error as a startup transient", async () => {
    let checks = 0;
    let launches = 0;

    await ensureDaemonReady(
      {
        async health() {
          checks += 1;

          if (checks === 1) {
            const error = new Error("Was there a typo in the url or port?");
            (error as NodeJS.ErrnoException).code = "FailedToOpenSocket";
            throw error;
          }

          return { ok: true };
        },
      },
      async () => {
        launches += 1;
      },
      async () => undefined,
      { attempts: 2, pollIntervalMs: 1 },
    );

    expect(launches).toBe(1);
  });

  it("treats Bun's typo message without a code as a startup transient", async () => {
    let checks = 0;
    let launches = 0;

    await ensureDaemonReady(
      {
        async health() {
          checks += 1;

          if (checks === 1) {
            throw new Error("Was there a typo in the url or port?");
          }

          return { ok: true };
        },
      },
      async () => {
        launches += 1;
      },
      async () => undefined,
      { attempts: 2, pollIntervalMs: 1 },
    );

    expect(launches).toBe(1);
  });
});
