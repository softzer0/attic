import { describe, expect, it, vi } from "vitest";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";

import { buildTagGenerationKey } from "../../src/core/canonical.js";
import {
  AtticCommittedInstallationError,
  AtticCommittedSyncError,
  AtticRecoveryRequiredError,
} from "../../src/core/errors.js";
import type { AtticEvent } from "../../src/core/types.js";
import { AtticEngine } from "../../src/engine.js";
import { deferred, FakePrismaRawClient, FakeRedis, TEST_MANIFEST } from "./attic-fakes.js";

function createEngine(
  database = new FakePrismaRawClient(),
  redis = new FakeRedis(),
  onEvent?: (event: AtticEvent) => void,
): AtticEngine {
  return new AtticEngine(database, {
    manifest: TEST_MANIFEST,
    redis,
    worker: false,
    ...(onEvent === undefined ? {} : { onEvent }),
  });
}

describe("AtticEngine reads", () => {
  it("does not start when a manifest generation in Redis is ahead of durable PostgreSQL", async () => {
    const redis = new FakeRedis();
    redis.values.set(buildTagGenerationKey(TEST_MANIFEST.namespace, "model:User"), "9");
    const engine = createEngine(new FakePrismaRawClient(), redis);

    await expect(engine.start()).rejects.toBeInstanceOf(AtticRecoveryRequiredError);
    await expect(engine.health()).resolves.toMatchObject({
      started: false,
      schema: "current",
      redis: "unavailable",
    });
  });

  it("revalidates the live trigger installation in health checks", async () => {
    const database = new FakePrismaRawClient();
    const engine = createEngine(database, new FakeRedis());
    await engine.start();
    database.liveTriggers = [];

    await expect(engine.health()).resolves.toMatchObject({ database: "ready", schema: "stale" });
    await engine.stop();
  });

  it("caches a database miss and serves the subsequent read from Redis", async () => {
    const database = new FakePrismaRawClient();
    const redis = new FakeRedis();
    const engine = createEngine(database, redis);
    const load = vi.fn(() => Promise.resolve({ id: 1, name: "Ada" }));
    const input = {
      model: "User",
      operation: "findUnique",
      args: { where: { id: 1 } },
      load,
    } as const;

    await expect(engine.readModel(input)).resolves.toEqual({ id: 1, name: "Ada" });
    await expect(engine.readModel(input)).resolves.toEqual({ id: 1, name: "Ada" });

    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.cacheKeys()).toHaveLength(1);
    await engine.stop();
  });

  it("distinguishes a cached null from a miss and uses the negative TTL", async () => {
    const redis = new FakeRedis();
    const engine = createEngine(new FakePrismaRawClient(), redis);
    const load = vi.fn(() => Promise.resolve(null));
    const input = {
      model: "User",
      operation: "findUnique",
      args: { where: { id: 404 } },
      load,
    } as const;

    await expect(engine.readModel(input)).resolves.toBeNull();
    await expect(engine.readModel(input)).resolves.toBeNull();

    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0]?.key).toContain(`${TEST_MANIFEST.namespace}:cache:`);
    expect(redis.setCalls[0]?.options).toEqual({ expiration: { type: "PX", value: 5_000 } });
    await engine.stop();
  });

  it("negative-caches Prisma not-found errors without changing their error class", async () => {
    const redis = new FakeRedis();
    const engine = createEngine(new FakePrismaRawClient(), redis);
    const failure = new PrismaClientKnownRequestError("No User found", {
      code: "P2025",
      clientVersion: "7.8.0",
    });
    const load = vi.fn(() => Promise.reject(failure));
    const input = {
      model: "User",
      operation: "findUniqueOrThrow",
      args: { where: { id: 404 } },
      load,
    } as const;

    await expect(engine.readModel(input)).rejects.toBe(failure);
    await expect(engine.readModel(input)).rejects.toMatchObject({ code: "P2025" });
    await expect(engine.readModel(input)).rejects.toBeInstanceOf(PrismaClientKnownRequestError);

    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.setCalls[0]?.options).toEqual({ expiration: { type: "PX", value: 5_000 } });
    await engine.stop();
  });

  it("falls back to PostgreSQL without filling when Redis reads fail", async () => {
    const redis = new FakeRedis();
    redis.getError = new Error("Redis unavailable");
    const engine = createEngine(new FakePrismaRawClient(), redis);
    const load = vi.fn(() => Promise.resolve({ id: 1 }));
    const input = {
      model: "User",
      operation: "findUnique",
      args: { where: { id: 1 } },
      load,
    } as const;

    await expect(engine.readModel(input)).resolves.toEqual({ id: 1 });
    await expect(engine.readModel(input)).resolves.toEqual({ id: 1 });

    expect(load).toHaveBeenCalledTimes(2);
    expect(redis.setCalls).toHaveLength(0);
    await engine.stop();
  });

  it("makes a slow stale fill unreachable after a concurrent generation advance", async () => {
    const database = new FakePrismaRawClient();
    const redis = new FakeRedis();
    const engine = createEngine(database, redis);
    const loadStarted = deferred<undefined>();
    const staleValue = deferred<{ readonly id: number; readonly version: string }>();
    const staleLoad = vi.fn(() => {
      loadStarted.resolve(undefined);
      return staleValue.promise;
    });

    const staleRead = engine.readModel({
      model: "User",
      operation: "findUnique",
      args: { where: { id: 1 } },
      load: staleLoad,
    });
    await loadStarted.promise;

    await expect(engine.write(() => Promise.resolve("updated"))).resolves.toBe("updated");
    staleValue.resolve({ id: 1, version: "old" });
    await expect(staleRead).resolves.toEqual({ id: 1, version: "old" });

    const freshLoad = vi.fn(() => Promise.resolve({ id: 1, version: "new" }));
    await expect(
      engine.readModel({
        model: "User",
        operation: "findUnique",
        args: { where: { id: 1 } },
        load: freshLoad,
      }),
    ).resolves.toEqual({ id: 1, version: "new" });

    expect(staleLoad).toHaveBeenCalledTimes(1);
    expect(freshLoad).toHaveBeenCalledTimes(1);
    expect(redis.cacheKeys()).toHaveLength(2);
    expect(redis.generation("model:User")).toBe("1");
    await engine.stop();
  });

  it("isolates otherwise-identical reads by asynchronous scope", async () => {
    const engine = createEngine();
    const load = vi.fn(() => Promise.resolve({ id: 1 }));
    const read = () =>
      engine.readModel({
        model: "User",
        operation: "findUnique",
        args: { where: { id: 1 } },
        load,
      });

    await engine.withScope("tenant-a", async () => {
      await read();
      await read();
    });
    await engine.withScope("tenant-b", read);

    expect(load).toHaveBeenCalledTimes(2);
    await engine.stop();
  });

  it("requires explicit raw dependencies and caches tagged raw reads", async () => {
    const engine = createEngine();
    const load = vi.fn(() => Promise.resolve([{ id: 1 }]));

    await expect(engine.readRaw({ sql: "SELECT $1 AS id", values: [1], tags: [], load })).rejects.toThrow(
      /at least one dependency tag/u,
    );
    const input = { sql: "SELECT $1 AS id", values: [1], tags: ["model:User"], load } as const;
    await engine.readRaw(input);
    await engine.readRaw(input);

    expect(load).toHaveBeenCalledTimes(1);
    await engine.stop();
  });
});

describe("AtticEngine writes", () => {
  it("falls back to durable global invalidation and reports a committed installation failure when triggers emit nothing", async () => {
    const database = new FakePrismaRawClient();
    database.writeTags = [];
    const redis = new FakeRedis();
    const engine = createEngine(database, redis);

    await expect(engine.write(() => Promise.resolve({ id: 1 }), true)).rejects.toBeInstanceOf(
      AtticCommittedInstallationError,
    );

    expect(redis.generation("$attic:all")).toBe("1");
    expect(database.outbox).toHaveLength(0);
    await expect(
      engine.readModel({
        model: "User",
        operation: "findUnique",
        args: { where: { id: 1 } },
        load: () => Promise.resolve({ id: 1 }),
      }),
    ).rejects.toMatchObject({ code: "ATTIC_INSTALLATION_INVALID" });
    await engine.stop();
  });

  it("does not require an outbox event for raw execute operations", async () => {
    const database = new FakePrismaRawClient();
    database.writeTags = [];
    const engine = createEngine(database, new FakeRedis());

    await expect(engine.write(() => Promise.resolve(0), false)).resolves.toBe(0);
    await engine.stop();
  });

  it("returns the committed result after synchronizing and acknowledging its outbox events", async () => {
    const database = new FakePrismaRawClient();
    const redis = new FakeRedis();
    const events: AtticEvent[] = [];
    const engine = createEngine(database, redis, (event) => events.push(event));

    await expect(engine.write(() => Promise.resolve({ id: 1 }))).resolves.toEqual({ id: 1 });

    expect(redis.generation("$attic:all")).toBe("1");
    expect(redis.generation("model:User")).toBe("1");
    expect(database.outbox).toHaveLength(0);
    expect(events.some((event) => event.type === "write.committed")).toBe(true);
    expect(events.some((event) => event.type === "write.synchronized")).toBe(true);
    await engine.stop();
  });

  it("reports a committed error and leaves durable events pending when Redis synchronization fails", async () => {
    const database = new FakePrismaRawClient();
    const redis = new FakeRedis();
    redis.evalError = new Error("Redis write unavailable");
    const engine = createEngine(database, redis);
    const writeWasExecuted = vi.fn(() => Promise.resolve({ id: 1 }));

    const result = engine.write(writeWasExecuted);
    await expect(result).rejects.toMatchObject({
      committed: true,
      code: "ATTIC_COMMITTED_SYNC",
    });
    await expect(result).rejects.toBeInstanceOf(AtticCommittedSyncError);

    expect(writeWasExecuted).toHaveBeenCalledTimes(1);
    expect(database.outbox).toHaveLength(2);
    await engine.stop();
  });

  it("persists manual tag and global invalidations before advancing Redis", async () => {
    const database = new FakePrismaRawClient();
    const redis = new FakeRedis();
    const engine = createEngine(database, redis);

    await engine.invalidate({ tags: ["custom", "custom"] });
    await engine.invalidateAll();

    expect(redis.generation("custom")).toBe("1");
    expect(redis.generation("$attic:all")).toBe("1");
    expect(database.outbox).toHaveLength(0);
    await engine.stop();
  });
});
