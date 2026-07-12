import { describe, expect, it } from "vitest";

import {
  DistributedLockManager,
  SingleFlight,
  type RedisEvalOptions,
  type RedisLike,
  type RedisSetOptions,
} from "../../src/core/index.js";

class LockRedis implements RedisLike {
  public readonly values = new Map<string, string>();

  public get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  public set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    if (options?.condition === "NX" && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  public del(key: string): Promise<number> {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }

  public eval(_script: string, options?: RedisEvalOptions): Promise<unknown> {
    const key = options?.keys?.[0];
    const token = options?.arguments?.[0];
    if (key === undefined || token === undefined || this.values.get(key) !== token) return Promise.resolve(0);
    this.values.delete(key);
    return Promise.resolve(1);
  }
}

describe("core concurrency primitives", () => {
  it("coalesces concurrent work and clears successful entries", async () => {
    const singleFlight = new SingleFlight();
    let calls = 0;
    const work = async (): Promise<number> => {
      calls += 1;
      await Promise.resolve();
      return 42;
    };

    const [first, second] = await Promise.all([singleFlight.run("same", work), singleFlight.run("same", work)]);

    expect([first, second]).toEqual([42, 42]);
    expect(calls).toBe(1);
    expect(singleFlight.size).toBe(0);
  });

  it("clears rejected work so a later attempt can retry", async () => {
    const singleFlight = new SingleFlight();
    await expect(singleFlight.run("retry", () => Promise.reject(new Error("first")))).rejects.toThrow("first");
    await expect(singleFlight.run("retry", () => "second")).resolves.toBe("second");
  });

  it("acquires one distributed lease and releases only its own token", async () => {
    const redis = new LockRedis();
    const locks = new DistributedLockManager(redis, "attic");
    const lease = await locks.acquire("cache-key", 1_000);

    expect(lease).not.toBeNull();
    await expect(locks.acquire("cache-key", 1_000)).resolves.toBeNull();
    if (lease === null) throw new Error("Expected a lease");

    redis.values.set(lease.key, "new-owner-token");
    await expect(lease.release()).resolves.toBe(false);
    expect(redis.values.get(lease.key)).toBe("new-owner-token");
    await expect(lease.release()).resolves.toBe(false);
  });
});
