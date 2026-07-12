import { describe, expect, it } from "vitest";
import type { RedisClientType, RedisClusterType } from "redis";

import {
  AtticSerializationError,
  RedisCacheStore,
  type RedisEvalOptions,
  type RedisLike,
  type RedisSetOptions,
} from "../../src/core/index.js";

const officialClientsAreCompatible: [
  RedisClientType extends RedisLike ? true : false,
  RedisClusterType extends RedisLike ? true : false,
] = [true, true];

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

function incrementDecimal(value: string): string {
  return (BigInt(value) + 1n).toString();
}

class StoreRedis implements RedisLike {
  public readonly values = new Map<string, string>();
  public lastSetOptions: RedisSetOptions | undefined;
  public readonly evalKeyCounts: number[] = [];

  public get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  public set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    this.lastSetOptions = options;
    if (options?.condition === "NX" && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  public del(key: string): Promise<number> {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }

  public eval(script: string, options?: RedisEvalOptions): Promise<unknown> {
    const keys = options?.keys ?? [];
    this.evalKeyCounts.push(keys.length);
    const key = keys[0];
    if (key === undefined) throw new Error("Expected script key");

    const current = this.values.get(key) ?? "0";
    if (script.includes("local incoming")) {
      const incoming = options?.arguments?.[0];
      if (incoming === undefined) throw new Error("Expected incoming generation");
      if (!this.values.has(key) || compareDecimal(incoming, current) > 0) this.values.set(key, incoming);
      return Promise.resolve(this.values.get(key));
    }

    if (script.includes("local digits")) {
      const next = incrementDecimal(current);
      this.values.set(key, next);
      return Promise.resolve(next);
    }

    throw new Error("Unexpected script");
  }
}

describe("core Redis cache store", () => {
  it("accepts the official regular and cluster client types", () => {
    expect(officialClientsAreCompatible).toEqual([true, true]);
  });
  it("distinguishes cached null from a miss and applies millisecond TTLs", async () => {
    const redis = new StoreRedis();
    const store = new RedisCacheStore(redis, { namespace: "attic" });

    expect(await store.get("cache:key")).toEqual({ hit: false, reason: "missing" });
    await store.set("cache:key", null, 1_234);
    expect(await store.get("cache:key")).toEqual({ hit: true, value: null });
    expect(redis.lastSetOptions).toEqual({ expiration: { type: "PX", value: 1_234 } });
  });

  it("turns corrupt cache payloads into misses and removes them", async () => {
    const redis = new StoreRedis();
    const store = new RedisCacheStore(redis, { namespace: "attic" });
    redis.values.set("cache:key", "malformed");

    expect(await store.get("cache:key")).toEqual({ hit: false, reason: "corrupt" });
    expect(redis.values.has("cache:key")).toBe(false);
  });

  it("reports an evicted generation separately from generation zero", async () => {
    const store = new RedisCacheStore(new StoreRedis(), { namespace: "attic" });

    expect(await store.getGenerationState("model:User")).toEqual({ found: false, generation: "0" });
    await store.setGeneration("model:User", 0);
    expect(await store.getGenerationState("model:User")).toEqual({ found: true, generation: "0" });
  });

  it("advances generations monotonically without numeric precision loss", async () => {
    const redis = new StoreRedis();
    const store = new RedisCacheStore(redis, { namespace: "attic" });
    const huge = "999999999999999999999999999999999999";

    await expect(store.setGeneration("model:User", huge)).resolves.toBe(huge);
    await expect(store.setGeneration("model:User", "42")).resolves.toBe(huge);
    await expect(store.incrementGeneration("model:User")).resolves.toBe("1000000000000000000000000000000000000");
    expect(redis.evalKeyCounts.every((count) => count === 1)).toBe(true);
  });

  it("deduplicates batch updates by their highest generation", async () => {
    const store = new RedisCacheStore(new StoreRedis(), { namespace: "attic" });
    const generations = await store.setGenerations([
      { tag: "model:User", generation: 2 },
      { tag: "model:User", generation: 10 },
      { tag: "model:Post", generation: 3 },
    ]);

    expect(generations).toEqual({ "model:Post": "3", "model:User": "10" });
  });

  it("rejects invalid generation state", async () => {
    const redis = new StoreRedis();
    const store = new RedisCacheStore(redis, { namespace: "attic" });
    const key = [...redis.values.keys()][0];
    expect(key).toBeUndefined();

    await store.setGeneration("model:User", 1);
    const generationKey = [...redis.values.keys()][0];
    if (generationKey === undefined) throw new Error("Expected generation key");
    redis.values.set(generationKey, "invalid");

    await expect(store.getGeneration("model:User")).rejects.toBeInstanceOf(AtticSerializationError);
  });
});
