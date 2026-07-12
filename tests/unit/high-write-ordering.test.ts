import { describe, expect, it, vi } from "vitest";

import { RedisCacheStore } from "../../src/core/redis-store.js";
import type { RedisEvalOptions, RedisLike } from "../../src/core/types.js";
import type { AtticDatabase, OutboxEvent } from "../../src/database.js";
import { AtticWorker } from "../../src/worker.js";
import { deferred, TEST_MANIFEST } from "./attic-fakes.js";

function compareGeneration(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

/** Forces generation 1 writes to finish after generation 2 writes. */
class ReorderedGenerationRedis implements RedisLike {
  public readonly values = new Map<string, string>();
  private readonly newerGenerationSeen = deferred<undefined>();

  public get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  public set(): Promise<string | null> {
    return Promise.resolve("OK");
  }

  public del(key: string): Promise<number> {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }

  public async eval(_script: string, options?: RedisEvalOptions): Promise<unknown> {
    const key = options?.keys?.[0];
    const incoming = options?.arguments?.[0];
    if (key === undefined || incoming === undefined) throw new Error("Expected a generation script call.");

    if (incoming === "1") await this.newerGenerationSeen.promise;
    const current = this.values.get(key);
    if (current === undefined || compareGeneration(incoming, current) > 0) this.values.set(key, incoming);
    if (incoming === "2") this.newerGenerationSeen.resolve(undefined);
    return this.values.get(key);
  }
}

function event(id: string, tag: string, generation: string, requestId: string): OutboxEvent {
  return {
    id,
    namespace: TEST_MANIFEST.namespace,
    tag,
    generation,
    requestId,
    attempts: 1,
  };
}

function workerDatabase(events: readonly OutboxEvent[], acknowledge: (ids: readonly string[]) => void): AtticDatabase {
  let claimed = false;
  return {
    claimEvents: vi.fn(() => {
      if (claimed) return Promise.resolve([]);
      claimed = true;
      return Promise.resolve(events);
    }),
    acknowledgeEvents: vi.fn((_workerId: string, ids: readonly string[]) => {
      acknowledge(ids);
      return Promise.resolve();
    }),
    releaseEvents: vi.fn(() => Promise.resolve()),
    loadAllGenerations: vi.fn(() => Promise.resolve(new Map<string, string>())),
  } as unknown as AtticDatabase;
}

describe("high-write generation ordering", () => {
  it("keeps the highest same-tag generation when completions arrive out of order", async () => {
    const redis = new ReorderedGenerationRedis();
    const generations = new RedisCacheStore(redis, { namespace: TEST_MANIFEST.namespace });

    const older = generations.setGeneration("model:User", "1");
    const newer = generations.setGeneration("model:User", "2");

    await expect(Promise.all([older, newer])).resolves.toEqual(["2", "2"]);
    await expect(generations.getGeneration("model:User")).resolves.toBe("2");
  });

  it("converges when two committed transactions deliver model tags in opposite orders", async () => {
    const redis = new ReorderedGenerationRedis();
    const generations = new RedisCacheStore(redis, { namespace: TEST_MANIFEST.namespace });
    const acknowledgements: string[][] = [];
    const first = new AtticWorker(
      workerDatabase(
        [event("1", "model:User", "2", "transaction-a"), event("2", "model:Post", "1", "transaction-a")],
        (ids) => acknowledgements.push([...ids]),
      ),
      generations,
    );
    const second = new AtticWorker(
      workerDatabase(
        [event("3", "model:Post", "2", "transaction-b"), event("4", "model:User", "1", "transaction-b")],
        (ids) => acknowledgements.push([...ids]),
      ),
      generations,
    );

    await expect(Promise.all([first.runOnce(), second.runOnce()])).resolves.toEqual([2, 2]);

    await expect(generations.getGeneration("model:User")).resolves.toBe("2");
    await expect(generations.getGeneration("model:Post")).resolves.toBe("2");
    expect(acknowledgements).toHaveLength(2);
    expect(acknowledgements.flat().sort()).toEqual(["1", "2", "3", "4"]);
  });
});
