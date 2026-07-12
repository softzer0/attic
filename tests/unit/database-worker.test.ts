import { describe, expect, it, vi } from "vitest";

import { AtticInstallationError, AtticRecoveryRequiredError, AtticSchemaMismatchError } from "../../src/core/errors.js";
import { AtticDatabase, type OutboxEvent } from "../../src/database.js";
import { AtticWorker, type GenerationStore } from "../../src/worker.js";
import { FakePrismaRawClient, TEST_MANIFEST } from "./attic-fakes.js";

function event(id: string, tag: string, generation: string, attempts = 1): OutboxEvent {
  return {
    id,
    namespace: TEST_MANIFEST.namespace,
    tag,
    generation,
    requestId: "request-id",
    attempts,
  };
}

describe("AtticDatabase", () => {
  it("validates the installed manifest checksum", async () => {
    const client = new FakePrismaRawClient();
    const database = new AtticDatabase(client, TEST_MANIFEST);

    await expect(database.validateSchema()).resolves.toBeUndefined();

    client.installationChecksum = "stale-checksum";
    await expect(database.validateSchema()).rejects.toMatchObject({
      expectedChecksum: TEST_MANIFEST.schemaChecksum,
      actualChecksum: "stale-checksum",
    });
    await expect(database.validateSchema()).rejects.toBeInstanceOf(AtticSchemaMismatchError);
  });

  it("rejects a stale SQL ABI and invalid live trigger definitions", async () => {
    const client = new FakePrismaRawClient();
    const database = new AtticDatabase(client, TEST_MANIFEST);

    client.installationSqlAbiVersion = 99;
    await expect(database.validateSchema()).rejects.toBeInstanceOf(AtticInstallationError);

    client.installationSqlAbiVersion = TEST_MANIFEST.sqlAbiVersion;
    const first = client.liveTriggers[0];
    const second = client.liveTriggers[1];
    if (first === undefined || second === undefined) throw new Error("Expected trigger fixtures.");
    client.liveTriggers = [
      {
        ...first,
        enabled: "D",
        arguments_hex: Buffer.from(`${TEST_MANIFEST.namespace}\0wrong-tag\0`).toString("hex"),
      },
      { ...second, table_name: "wrong_table" },
    ];

    const validationError: unknown = await database.validateSchema().catch((error: unknown) => error);
    expect(validationError).toBeInstanceOf(AtticInstallationError);
    if (!(validationError instanceof AtticInstallationError)) throw validationError;
    expect(validationError.code).toBe("ATTIC_INSTALLATION_INVALID");
    const issues = validationError.issues.join(" ");
    expect(issues).toContain("not enabled");
    expect(issues).toContain("arguments differ");
    expect(issues).toContain("Missing trigger");
    expect(issues).toContain("Unexpected trigger");
  });

  it("classifies a missing Attic table without masking connection failures", async () => {
    const client = new FakePrismaRawClient();
    const database = new AtticDatabase(client, TEST_MANIFEST);

    client.queryError = Object.assign(new Error("relation does not exist"), {
      code: "P2010",
      meta: { code: "42P01" },
    });
    await expect(database.validateSchema()).rejects.toMatchObject({
      code: "ATTIC_SCHEMA_MISMATCH",
      actualChecksum: null,
    });

    const outage = new Error("connection refused");
    client.queryError = outage;
    await expect(database.validateSchema()).rejects.toBe(outage);
  });

  it("sets transaction-local request context in the same batch as a write", async () => {
    const client = new FakePrismaRawClient();
    const database = new AtticDatabase(client, TEST_MANIFEST);

    const result = await database.runWrite<{ readonly id: number }>(Promise.resolve({ id: 7 }));

    expect(result.result).toEqual({ id: 7 });
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(client.batchTransactions).toHaveLength(1);
    expect(client.queryCalls.some((call) => call.sql.includes("set_config('attic.request_id'"))).toBe(true);
    await expect(database.requestEvents(result.requestId)).resolves.toHaveLength(2);
  });

  it("sets request context before an interactive transaction callback and forwards its options", async () => {
    const client = new FakePrismaRawClient();
    const database = new AtticDatabase(client, TEST_MANIFEST);
    const callback = vi.fn(() => {
      expect(client.lastRequestId).toBeDefined();
      return Promise.resolve("committed");
    });

    const result = await database.runTransaction(callback, {
      maxWait: 100,
      timeout: 500,
      isolationLevel: "Serializable",
    });

    expect(result.result).toBe("committed");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(client.transactionOptions.at(-1)).toEqual({
      maxWait: 100,
      timeout: 500,
      isolationLevel: "Serializable",
    });
  });

  it("reports structured outbox health without exposing event payloads", async () => {
    const client = new FakePrismaRawClient();
    const database = new AtticDatabase(client, TEST_MANIFEST);
    await database.runWrite(Promise.resolve(undefined));

    await expect(database.outboxHealth()).resolves.toEqual({
      pendingEvents: 2,
      availableEvents: 2,
      leasedEvents: 0,
      maxAttempts: 0,
      oldestEventAgeMs: 0,
    });
    await expect(database.backlogSize()).resolves.toBe(2);
  });
});

describe("AtticWorker", () => {
  it("groups a leased batch by tag, writes only its highest generations, and acknowledges every event", async () => {
    const events = [
      event("1", "model:User", "2"),
      event("2", "model:User", "10"),
      event("3", "model:User", "7"),
      event("4", "model:Post", "3"),
    ];
    const acknowledgeEvents = vi.fn(() => Promise.resolve());
    const releaseEvents = vi.fn(() => Promise.resolve());
    const database = {
      claimEvents: vi.fn(() => Promise.resolve(events)),
      acknowledgeEvents,
      releaseEvents,
      loadAllGenerations: vi.fn(() => Promise.resolve(new Map<string, string>())),
    } as unknown as AtticDatabase;
    const current = new Map<string, string>([["model:User", "12"]]);
    const setGeneration = vi.fn((tag: string, generation: string) => {
      const existing = current.get(tag) ?? "0";
      if (BigInt(generation) > BigInt(existing)) current.set(tag, generation);
      return Promise.resolve(current.get(tag));
    });
    const writer: GenerationStore = {
      setGeneration,
      getGenerationState: (tag) => Promise.resolve({ found: current.has(tag), generation: current.get(tag) ?? "0" }),
    };
    const worker = new AtticWorker(database, writer);

    await expect(worker.runOnce()).resolves.toBe(4);

    expect(setGeneration).toHaveBeenCalledTimes(2);
    expect(setGeneration).toHaveBeenCalledWith("model:User", "10");
    expect(setGeneration).toHaveBeenCalledWith("model:Post", "3");
    expect(current.get("model:User")).toBe("12");
    expect(acknowledgeEvents).toHaveBeenCalledWith(worker.health().workerId, ["1", "2", "3", "4"]);
    expect(releaseEvents).not.toHaveBeenCalled();
    expect(worker.health()).toMatchObject({
      processedEvents: 4,
      successfulBatches: 1,
      failedBatches: 0,
      retriedEvents: 0,
    });
    expect(worker.health().lastSuccessAt).toBeInstanceOf(Date);
  });

  it("releases a failed batch with capped exponential backoff and does not acknowledge it", async () => {
    const events = [event("8", "model:User", "8", 4)];
    const failure = new Error("Redis unavailable");
    const acknowledgeEvents = vi.fn(() => Promise.resolve());
    const releaseEvents = vi.fn(() => Promise.resolve());
    const database = {
      claimEvents: vi.fn(() => Promise.resolve(events)),
      acknowledgeEvents,
      releaseEvents,
      loadAllGenerations: vi.fn(() => Promise.resolve(new Map<string, string>())),
    } as unknown as AtticDatabase;
    const writer: GenerationStore = {
      setGeneration: vi.fn(() => Promise.reject(failure)),
      getGenerationState: () => Promise.resolve({ found: false, generation: "0" }),
    };
    const worker = new AtticWorker(database, writer, { initialBackoffMs: 10, maxBackoffMs: 50 });

    await expect(worker.runOnce()).rejects.toBe(failure);

    expect(acknowledgeEvents).not.toHaveBeenCalled();
    expect(releaseEvents).toHaveBeenCalledWith(worker.health().workerId, ["8"], 50, failure);
    expect(worker.health()).toMatchObject({
      lastError: failure,
      processedEvents: 0,
      successfulBatches: 0,
      failedBatches: 1,
      retriedEvents: 1,
    });
  });

  it("requires explicit recovery when Redis is ahead of an absent durable manifest tag", async () => {
    const database = {
      loadAllGenerations: vi.fn(() => Promise.resolve(new Map<string, string>())),
      loadGenerations: vi.fn(() => Promise.resolve(new Map([["model:User", "0"]]))),
    } as unknown as AtticDatabase;
    const setGeneration = vi.fn(() => Promise.resolve("0"));
    const store: GenerationStore = {
      setGeneration,
      getGenerationState: (tag) =>
        Promise.resolve(tag === "model:User" ? { found: true, generation: "4" } : { found: false, generation: "0" }),
    };
    const worker = new AtticWorker(database, store);

    const reconciliation = worker.reconcileGenerations(["$attic:all", "model:User"]);
    await expect(reconciliation).rejects.toBeInstanceOf(AtticRecoveryRequiredError);
    await expect(reconciliation).rejects.toMatchObject({
      divergences: [{ tag: "model:User", redisGeneration: "4", durableGeneration: "0" }],
    });
    expect(setGeneration).not.toHaveBeenCalled();
  });

  it("does not report restore divergence when PostgreSQL catches up during reconciliation", async () => {
    const database = {
      loadAllGenerations: vi.fn(() => Promise.resolve(new Map([["model:User", "1"]]))),
      loadGenerations: vi.fn(() => Promise.resolve(new Map([["model:User", "2"]]))),
    } as unknown as AtticDatabase;
    const setGeneration = vi.fn(() => Promise.resolve("2"));
    const store: GenerationStore = {
      setGeneration,
      getGenerationState: () => Promise.resolve({ found: true, generation: "2" }),
    };
    const worker = new AtticWorker(database, store);

    await expect(worker.reconcileGenerations(["model:User"])).resolves.toBeUndefined();
    expect(setGeneration).toHaveBeenCalledWith("model:User", "2");
  });
});
