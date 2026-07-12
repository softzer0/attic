import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";

import { buildCacheKey, buildRawCacheKey, normalizeNamespace } from "./core/canonical.js";
import { cacheTtlFor, resolveCachePolicy } from "./core/cache-policy.js";
import { DistributedLockManager, type DistributedLockLease } from "./core/distributed-lock.js";
import {
  AtticCommittedInstallationError,
  AtticCommittedSyncError,
  AtticConfigurationError,
  AtticInstallationError,
  AtticRecoveryRequiredError,
  AtticSchemaMismatchError,
} from "./core/errors.js";
import { RedisCacheStore } from "./core/redis-store.js";
import { SingleFlight } from "./core/single-flight.js";
import { normalizeTags, resolveDependencyTags } from "./core/tags.js";
import {
  ATTIC_GLOBAL_TAG,
  ATTIC_MANIFEST_VERSION,
  ATTIC_SQL_ABI_VERSION,
  type AtticEvent,
  type AtticHealth,
  type AtticOptions,
  type AtticTransactionOptions,
  type CacheStrategy,
  type CacheTag,
  type EnabledCachePolicy,
  type TagGeneration,
} from "./core/types.js";
import { AtticDatabase, type OutboxEvent, type PrismaRawClient } from "./database.js";
import { AtticWorker } from "./worker.js";

export interface ModelReadInput<T> {
  readonly model: string;
  readonly operation: string;
  readonly args: unknown;
  readonly cacheStrategy?: CacheStrategy;
  readonly load: () => Promise<T>;
}

export interface RawReadInput<T> {
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly tags: readonly CacheTag[];
  readonly ttlMs?: number;
  readonly load: () => Promise<T>;
}

export interface InvalidateInput {
  readonly tags: readonly CacheTag[];
}

export interface AtticEngineHealth extends AtticHealth {
  readonly worker: ReturnType<AtticWorker["health"]>;
}

const DEFAULT_LOCK_TTL_MS = 5_000;
const MAX_LOCK_WAIT_MS = 1_000;
const CACHE_ENTRY_VERSION = 1;

interface CachedValueEntry {
  readonly version: typeof CACHE_ENTRY_VERSION;
  readonly kind: "value";
  readonly value: unknown;
}

interface CachedNotFoundEntry {
  readonly version: typeof CACHE_ENTRY_VERSION;
  readonly kind: "not-found";
  readonly clientVersion: string;
}

type CachedEntry = CachedValueEntry | CachedNotFoundEntry;
type CachedEntryRead = { readonly hit: false } | { readonly hit: true; readonly entry: CachedEntry };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCachedEntry(value: unknown): value is CachedEntry {
  if (!isRecord(value) || value.version !== CACHE_ENTRY_VERSION) return false;
  if (value.kind === "value") return Object.hasOwn(value, "value");
  return value.kind === "not-found" && typeof value.clientVersion === "string";
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "P2025";
}

function notFoundClientVersion(error: unknown): string {
  return isRecord(error) && typeof error.clientVersion === "string" ? error.clientVersion : "unknown";
}

function cachedNotFoundError(entry: CachedNotFoundEntry): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError("No record was found for a cached query.", {
    code: "P2025",
    clientVersion: entry.clientVersion,
  });
}

function eventContext(model: string | undefined, operation: string | undefined): Record<string, string> {
  return {
    ...(model === undefined ? {} : { model }),
    ...(operation === undefined ? {} : { operation }),
  };
}

function groupEventGenerations(events: readonly OutboxEvent[]): readonly { tag: string; generation: string }[] {
  const grouped = new Map<string, string>();
  for (const event of events) {
    const current = grouped.get(event.tag);
    if (
      current === undefined ||
      event.generation.length > current.length ||
      (event.generation.length === current.length && event.generation > current)
    ) {
      grouped.set(event.tag, event.generation);
    }
  }
  return [...grouped].map(([tag, generation]) => ({ tag, generation }));
}

function validateScope(scope: string): string {
  const normalized = scope.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new AtticConfigurationError("An Attic scope must contain between 1 and 256 characters.");
  }
  return normalized;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class AtticEngine {
  public readonly namespace: string;
  public readonly worker: AtticWorker;

  private readonly options: AtticOptions;
  private readonly database: AtticDatabase;
  private readonly cache: RedisCacheStore;
  private readonly singleFlight = new SingleFlight();
  private readonly scope = new AsyncLocalStorage<string>();
  private readonly lock: DistributedLockManager | undefined;
  private readonly lockTtlMs: number;
  private startPromise: Promise<void> | undefined;
  private started = false;
  private databaseState: AtticHealth["database"] = "unavailable";
  private redisState: AtticHealth["redis"] = "unavailable";
  private schemaState: AtticHealth["schema"] = "unknown";
  private installationError: AtticInstallationError | AtticSchemaMismatchError | undefined;

  public constructor(client: PrismaRawClient, options: AtticOptions) {
    const manifestVersion: unknown = options.manifest.version;
    if (manifestVersion !== ATTIC_MANIFEST_VERSION) {
      throw new AtticConfigurationError(
        `Unsupported Attic manifest version ${String(manifestVersion)}; expected ${String(ATTIC_MANIFEST_VERSION)}.`,
      );
    }
    const sqlAbiVersion: unknown = options.manifest.sqlAbiVersion;
    if (sqlAbiVersion !== ATTIC_SQL_ABI_VERSION || !Array.isArray(options.manifest.triggers)) {
      throw new AtticConfigurationError(
        `Unsupported Attic SQL ABI ${String(sqlAbiVersion)}; expected ${String(ATTIC_SQL_ABI_VERSION)} with generated trigger metadata.`,
      );
    }

    this.options = options;
    this.namespace = normalizeNamespace(options.manifest.namespace);
    this.database = new AtticDatabase(client, options.manifest);
    this.cache = new RedisCacheStore(options.redis, {
      namespace: this.namespace,
      ...(options.codec === undefined ? {} : { codec: options.codec }),
    });

    const lockOptions = typeof options.distributedLock === "object" ? options.distributedLock : undefined;
    const lockEnabled =
      options.distributedLock === true || (lockOptions !== undefined && (lockOptions.enabled ?? true));
    this.lockTtlMs = lockOptions?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
    this.lock = lockEnabled ? new DistributedLockManager(options.redis, this.namespace) : undefined;

    const workerOptions = typeof options.worker === "object" ? options.worker : undefined;
    this.worker = new AtticWorker(this.database, this.cache, {
      ...(workerOptions?.pollIntervalMs === undefined ? {} : { pollIntervalMs: workerOptions.pollIntervalMs }),
      ...(workerOptions?.batchSize === undefined ? {} : { batchSize: workerOptions.batchSize }),
      ...(workerOptions?.leaseMs === undefined ? {} : { leaseMs: workerOptions.leaseMs }),
      ...(workerOptions?.maxBackoffMs === undefined ? {} : { maxBackoffMs: workerOptions.maxBackoffMs }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
  }

  public async start(): Promise<void> {
    if (this.started) {
      if (this.installationError !== undefined) throw this.installationError;
      return;
    }
    if (this.startPromise !== undefined) return this.startPromise;

    this.startPromise = this.initialize();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  public async stop(): Promise<void> {
    if (!this.started && this.startPromise === undefined) return;
    await this.startPromise;
    await this.worker.stop();
    this.singleFlight.clear();
    this.started = false;
    this.emit({ type: "engine.stopped" });
  }

  public async health(): Promise<AtticEngineHealth> {
    let outbox: AtticHealth["outbox"];
    try {
      await this.database.validateSchema();
      this.databaseState = "ready";
      this.schemaState = "current";
      this.installationError = undefined;
    } catch (error) {
      this.recordSchemaValidationError(error);
    }

    try {
      outbox = await this.database.outboxHealth();
      this.databaseState = "ready";
    } catch {
      this.databaseState = "unavailable";
    }

    return {
      started: this.started,
      redis: this.redisState,
      database: this.databaseState,
      schema: this.schemaState,
      ...(outbox === undefined ? {} : { outbox, pendingOutboxEvents: outbox.pendingEvents }),
      worker: this.worker.health(),
    };
  }

  public withScope<T>(scope: string, callback: () => T): T {
    return this.scope.run(validateScope(scope), callback);
  }

  public async readModel<T>(input: ModelReadInput<T>): Promise<T> {
    await this.ensureStarted();
    const policy = resolveCachePolicy(input.cacheStrategy, {
      ...(this.options.ttlMs === undefined ? {} : { ttlMs: this.options.ttlMs }),
      ...(this.options.negativeTtlMs === undefined ? {} : { negativeTtlMs: this.options.negativeTtlMs }),
    });

    if (!policy.enabled) {
      this.emit({
        type: "cache.bypass",
        ...eventContext(input.model, input.operation),
        reason: "cacheStrategy=false",
      });
      return input.load();
    }

    let tags: readonly CacheTag[];
    try {
      tags = resolveDependencyTags(this.options.manifest, input.model, input.args, policy.tags);
    } catch (error) {
      this.emit({ type: "cache.bypass", ...eventContext(input.model, input.operation), reason: "manifest" });
      throw error;
    }

    return this.readThrough(
      policy,
      tags,
      (generations) =>
        buildCacheKey({
          namespace: this.namespace,
          scope: this.scope.getStore(),
          model: input.model,
          operation: input.operation,
          args: input.args,
          generations,
        }),
      input.load,
      input.model,
      input.operation,
    );
  }

  public async readRaw<T>(input: RawReadInput<T>): Promise<T> {
    await this.ensureStarted();
    if (input.tags.length === 0) {
      throw new AtticConfigurationError("$attic.queryRaw requires at least one dependency tag.");
    }

    const policy = resolveCachePolicy(
      { ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }), tags: input.tags },
      {
        ...(this.options.ttlMs === undefined ? {} : { ttlMs: this.options.ttlMs }),
        ...(this.options.negativeTtlMs === undefined ? {} : { negativeTtlMs: this.options.negativeTtlMs }),
      },
    );
    if (!policy.enabled) return input.load();
    const tags = normalizeTags([ATTIC_GLOBAL_TAG, ...input.tags]);

    return this.readThrough(
      policy,
      tags,
      (generations) => buildRawCacheKey(this.namespace, input.sql, input.values, this.scope.getStore(), generations),
      input.load,
      undefined,
      "$queryRaw",
    );
  }

  public async write<T>(createQuery: () => PromiseLike<T>, requireOutboxEvent = true): Promise<T> {
    await this.ensureStarted();
    let committed = false;
    let requestId: string | undefined;

    try {
      const result = await this.database.runWrite<T>(createQuery());
      committed = true;
      requestId = result.requestId;
      this.emit({ type: "write.committed", requestId });
      await this.synchronizeRequest(requestId, requireOutboxEvent);
      return result.result;
    } catch (error) {
      if (committed && requestId !== undefined) {
        this.emit({ type: "write.error", requestId, committed: true, error });
        if (error instanceof AtticCommittedSyncError || error instanceof AtticCommittedInstallationError) throw error;
        throw new AtticCommittedSyncError(requestId, { cause: error });
      }
      this.emit({ type: "write.error", committed: false, error });
      throw error;
    }
  }

  public async transaction<T>(
    callback: (transaction: PrismaRawClient) => Promise<T>,
    options?: AtticTransactionOptions,
  ): Promise<T> {
    await this.ensureStarted();
    let committed = false;
    let requestId: string | undefined;

    try {
      const result = await this.database.runTransaction(callback, options);
      committed = true;
      requestId = result.requestId;
      this.emit({ type: "write.committed", requestId });
      await this.synchronizeRequest(requestId);
      return result.result;
    } catch (error) {
      if (committed && requestId !== undefined) {
        this.emit({ type: "write.error", requestId, committed: true, error });
        if (error instanceof AtticCommittedSyncError || error instanceof AtticCommittedInstallationError) throw error;
        throw new AtticCommittedSyncError(requestId, { cause: error });
      }
      this.emit({ type: "write.error", committed: false, error });
      throw error;
    }
  }

  public async invalidate(input: InvalidateInput): Promise<void> {
    await this.ensureStarted();
    const tags = normalizeTags(input.tags);
    if (tags.length === 0) throw new AtticConfigurationError("At least one cache tag is required for invalidation.");
    const requestId = randomUUID();

    let events: OutboxEvent[];
    try {
      events = await this.database.enqueueTags(tags, requestId);
      this.emit({ type: "write.committed", requestId });
    } catch (error) {
      this.emit({ type: "write.error", requestId, committed: false, error });
      throw error;
    }

    try {
      await this.synchronizeEvents(requestId, events);
    } catch (error) {
      this.emit({ type: "write.error", requestId, committed: true, error });
      throw new AtticCommittedSyncError(requestId, { cause: error });
    }
  }

  public invalidateAll(): Promise<void> {
    return this.invalidate({ tags: [ATTIC_GLOBAL_TAG] });
  }

  private async initialize(): Promise<void> {
    try {
      await this.database.validateSchema();
      this.databaseState = "ready";
      this.schemaState = "current";
      this.installationError = undefined;
    } catch (error) {
      this.recordSchemaValidationError(error);
      throw error;
    }

    try {
      await this.worker.reconcileGenerations(
        normalizeTags([ATTIC_GLOBAL_TAG, ...Object.values(this.options.manifest.models).map((model) => model.tag)]),
      );
      this.redisState = "ready";
    } catch (error) {
      this.redisState = "unavailable";
      this.emit({ type: "cache.error", operation: "write", error });
      if (error instanceof AtticRecoveryRequiredError) throw error;
    }

    this.started = true;
    const workerOptions = typeof this.options.worker === "object" ? this.options.worker : undefined;
    if (this.options.worker !== false && (workerOptions?.embedded ?? true)) this.worker.start();
    this.emit({ type: "engine.started" });
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) await this.start();
    if (this.installationError !== undefined) throw this.installationError;
  }

  private async generations(tags: readonly CacheTag[]): Promise<Readonly<Record<CacheTag, TagGeneration>>> {
    const states = await this.cache.getGenerationStates(tags);
    const generations: Record<CacheTag, TagGeneration> = {};
    const missing = Object.entries(states)
      .filter(([, state]) => !state.found)
      .map(([tag]) => tag);

    for (const [tag, state] of Object.entries(states)) {
      if (state.found) generations[tag] = state.generation;
    }

    if (missing.length > 0) {
      const durable = await this.database.loadGenerations(missing);
      const stored = await this.cache.setGenerations(
        missing.map((tag) => ({ tag, generation: durable.get(tag) ?? "0" })),
      );
      Object.assign(generations, stored);
    }

    return generations;
  }

  private async readThrough<T>(
    policy: EnabledCachePolicy,
    tags: readonly CacheTag[],
    keyFactory: (generations: Readonly<Record<CacheTag, TagGeneration>>) => string,
    load: () => Promise<T>,
    model: string | undefined,
    operation: string,
  ): Promise<T> {
    let key: string;
    let cached: CachedEntryRead;
    try {
      key = keyFactory(await this.generations(tags));
      cached = await this.readCacheEntry(key);
    } catch (error) {
      this.redisState = "unavailable";
      this.emit({ type: "cache.error", operation: "read", error });
      this.emit({ type: "cache.bypass", ...eventContext(model, operation), reason: "redis-or-key" });
      return load();
    }

    if (cached.hit) {
      this.redisState = "ready";
      this.emit({ type: "cache.hit", key, ...eventContext(model, operation) });
      if (cached.entry.kind === "not-found") throw cachedNotFoundError(cached.entry);
      return cached.entry.value as T;
    }
    this.emit({ type: "cache.miss", key, ...eventContext(model, operation) });

    return this.singleFlight.run(key, async () => {
      let lease: DistributedLockLease | null = null;
      let lockedEntry: CachedEntry | undefined;
      if (this.lock !== undefined) {
        try {
          lease = await this.lock.acquire(key, this.lockTtlMs);
          if (lease === null) {
            const waited = await this.waitForDistributedFill(key, Math.min(this.lockTtlMs, MAX_LOCK_WAIT_MS));
            if (waited.hit) lockedEntry = waited.entry;
          } else {
            const secondRead = await this.readCacheEntry(key);
            if (secondRead.hit) lockedEntry = secondRead.entry;
          }
        } catch (error) {
          this.emit({ type: "cache.error", operation: "read", error });
        }
      }

      try {
        if (lockedEntry !== undefined) {
          if (lockedEntry.kind === "not-found") throw cachedNotFoundError(lockedEntry);
          return lockedEntry.value as T;
        }

        try {
          const value = await load();
          try {
            await this.cache.set(
              key,
              { version: CACHE_ENTRY_VERSION, kind: "value", value } satisfies CachedValueEntry,
              cacheTtlFor(value, policy),
            );
            this.redisState = "ready";
          } catch (error) {
            this.redisState = "unavailable";
            this.emit({ type: "cache.error", operation: "write", error });
          }
          return value;
        } catch (error) {
          if (isNotFoundError(error)) {
            try {
              await this.cache.set(
                key,
                {
                  version: CACHE_ENTRY_VERSION,
                  kind: "not-found",
                  clientVersion: notFoundClientVersion(error),
                } satisfies CachedNotFoundEntry,
                policy.negativeTtlMs,
              );
              this.redisState = "ready";
            } catch (cacheError) {
              this.redisState = "unavailable";
              this.emit({ type: "cache.error", operation: "write", error: cacheError });
            }
          }
          throw error;
        }
      } finally {
        if (lease !== null) {
          try {
            await lease.release();
          } catch (error) {
            this.emit({ type: "cache.error", operation: "delete", error });
          }
        }
      }
    });
  }

  private async waitForDistributedFill(key: string, timeoutMs: number): Promise<CachedEntryRead> {
    const deadline = Date.now() + timeoutMs;
    let delayMs = 20;
    while (Date.now() < deadline) {
      await sleep(delayMs);
      const cached = await this.readCacheEntry(key);
      if (cached.hit) return cached;
      delayMs = Math.min(100, delayMs * 2);
    }
    return { hit: false };
  }

  private async readCacheEntry(key: string): Promise<CachedEntryRead> {
    const cached = await this.cache.get<unknown>(key);
    if (!cached.hit) return { hit: false };
    if (isCachedEntry(cached.value)) return { hit: true, entry: cached.value };

    try {
      await this.cache.delete(key);
    } catch (error) {
      this.emit({ type: "cache.error", operation: "delete", error });
    }
    return { hit: false };
  }

  private async synchronizeRequest(requestId: string, requireOutboxEvent = false): Promise<void> {
    let events: OutboxEvent[];
    try {
      events = await this.database.requestEvents(requestId);
      if (requireOutboxEvent && events.length === 0) {
        this.schemaState = "stale";
        this.installationError = new AtticInstallationError([
          `PostgreSQL transaction ${requestId} produced no model trigger event.`,
        ]);
        let fallbackError: unknown;
        try {
          const fallback = await this.database.enqueueTags([ATTIC_GLOBAL_TAG], requestId);
          await this.synchronizeEvents(requestId, fallback);
        } catch (error) {
          fallbackError = error;
        }
        throw new AtticCommittedInstallationError(
          requestId,
          fallbackError === undefined ? undefined : { cause: fallbackError },
        );
      }
      await this.synchronizeEvents(requestId, events);
    } catch (error) {
      if (error instanceof AtticCommittedInstallationError) throw error;
      throw new AtticCommittedSyncError(requestId, { cause: error });
    }
  }

  private async synchronizeEvents(requestId: string, events: readonly OutboxEvent[]): Promise<void> {
    const updates = groupEventGenerations(events);
    try {
      await this.cache.setGenerations(updates);
      this.redisState = "ready";
    } catch (error) {
      this.redisState = "unavailable";
      throw error;
    }

    try {
      await this.database.acknowledgeEvents(
        null,
        events.map((event) => event.id),
      );
    } catch (error) {
      // Redis is already current. Leaving idempotent events for the worker is safe.
      this.emit({ type: "cache.error", operation: "delete", error });
    }

    this.emit({ type: "write.synchronized", requestId, eventCount: events.length });
  }

  private emit(event: AtticEvent): void {
    this.options.onEvent?.(event);
  }

  private recordSchemaValidationError(error: unknown): void {
    if (error instanceof AtticSchemaMismatchError) {
      this.schemaState = error.actualChecksum === null ? "missing" : "stale";
      this.databaseState = "ready";
      this.installationError = error;
      return;
    }
    if (error instanceof AtticInstallationError) {
      this.schemaState = "stale";
      this.databaseState = "ready";
      this.installationError = error;
      return;
    }
    this.schemaState = "unknown";
    this.databaseState = "unavailable";
  }
}
