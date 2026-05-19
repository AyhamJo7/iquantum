import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter, RedisRateLimiter } from "./rate-limit";

function mockRedis(responses: [number, number][]): Pick<Redis, "eval"> {
  let call = 0;
  return {
    eval: (async (..._args: unknown[]) => responses[call++]) as unknown as Pick<
      Redis,
      "eval"
    >["eval"],
  };
}

describe("InMemoryRateLimiter", () => {
  it("allows requests within the limit", async () => {
    const limiter = new InMemoryRateLimiter();
    const result = await limiter.consume("key1", {
      limit: 3,
      windowMs: 60_000,
    });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("blocks when limit is exceeded", async () => {
    const limiter = new InMemoryRateLimiter();
    const opts = { limit: 2, windowMs: 60_000 };
    await limiter.consume("key2", opts);
    await limiter.consume("key2", opts);
    const result = await limiter.consume("key2", opts);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("resets the bucket after the window expires", async () => {
    const limiter = new InMemoryRateLimiter();
    const opts = { limit: 1, windowMs: 1 };
    await limiter.consume("key3", opts);
    await new Promise((r) => setTimeout(r, 5));
    const result = await limiter.consume("key3", opts);
    expect(result.allowed).toBe(true);
  });

  it("tracks separate keys independently", async () => {
    const limiter = new InMemoryRateLimiter();
    const opts = { limit: 1, windowMs: 60_000 };
    await limiter.consume("a", opts);
    const resultA = await limiter.consume("a", opts);
    const resultB = await limiter.consume("b", opts);
    expect(resultA.allowed).toBe(false);
    expect(resultB.allowed).toBe(true);
  });
});

describe("RedisRateLimiter", () => {
  it("calls eval with the correct key and windowMs", async () => {
    const calls: unknown[][] = [];
    const redis: Pick<Redis, "eval"> = {
      eval: (async (...args: unknown[]) => {
        calls.push(args);
        return [1, 60_000];
      }) as unknown as Pick<Redis, "eval">["eval"],
    };
    const limiter = new RedisRateLimiter(redis);
    await limiter.consume("test-key", { limit: 10, windowMs: 60_000 });
    expect(calls).toHaveLength(1);
    const [, keyCount, key, windowMs] = calls[0] as unknown[];
    expect(keyCount).toBe(1);
    expect(key).toBe("test-key");
    expect(windowMs).toBe("60000");
  });

  it("returns allowed:true when count is at the limit", async () => {
    const limiter = new RedisRateLimiter(mockRedis([[5, 30_000]]));
    const result = await limiter.consume("k", { limit: 5, windowMs: 60_000 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("returns allowed:false when count exceeds the limit", async () => {
    const limiter = new RedisRateLimiter(mockRedis([[6, 30_000]]));
    const result = await limiter.consume("k", { limit: 5, windowMs: 60_000 });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("computes resetAt from current time plus ttl", async () => {
    const ttl = 45_000;
    const limiter = new RedisRateLimiter(mockRedis([[1, ttl]]));
    const before = Date.now();
    const result = await limiter.consume("k", { limit: 10, windowMs: 60_000 });
    const after = Date.now();
    expect(result.resetAt).toBeGreaterThanOrEqual(before + ttl);
    expect(result.resetAt).toBeLessThanOrEqual(after + ttl);
  });

  it("clamps negative ttl to zero for resetAt", async () => {
    const limiter = new RedisRateLimiter(mockRedis([[1, -1]]));
    const before = Date.now();
    const result = await limiter.consume("k", { limit: 10, windowMs: 60_000 });
    expect(result.resetAt).toBeGreaterThanOrEqual(before);
  });
});
