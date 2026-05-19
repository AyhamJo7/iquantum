import type Redis from "ioredis";

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimiter {
  consume(key: string, options: RateLimitOptions): Promise<RateLimitResult>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Bucket>();

  async consume(
    key: string,
    options: RateLimitOptions,
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const current = this.#buckets.get(key);
    const bucket =
      current && current.resetAt > now
        ? current
        : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    this.#buckets.set(key, bucket);

    if (this.#buckets.size > 10_000) {
      this.#gc(now);
    }

    return {
      allowed: bucket.count <= options.limit,
      remaining: Math.max(0, options.limit - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  #gc(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now) {
        this.#buckets.delete(key);
      }
    }
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Pick<Redis, "eval">) {}

  async consume(
    key: string,
    options: RateLimitOptions,
  ): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.eval(
      REDIS_RATE_LIMIT_SCRIPT,
      1,
      key,
      String(options.windowMs),
    )) as [number, number];
    const resetAt = Date.now() + Math.max(ttl, 0);

    return {
      allowed: count <= options.limit,
      remaining: Math.max(0, options.limit - count),
      resetAt,
    };
  }
}

const REDIS_RATE_LIMIT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return { count, redis.call("PTTL", KEYS[1]) }
`;
