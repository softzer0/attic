export const ATTIC_MANIFEST_VERSION = 1 as const;
export const ATTIC_SQL_ABI_VERSION = 1 as const;
export const ATTIC_GLOBAL_TAG = "$attic:all";

declare const ATTIC_CLIENT_TYPE: unique symbol;

export type CacheTag = string;
export type TagGeneration = string;

export interface RelationManifest {
  readonly field: string;
  readonly model: string;
  readonly isList: boolean;
  readonly dependencies: readonly CacheTag[];
}

export interface ModelManifest {
  readonly name: string;
  readonly dbName: string;
  readonly schema: string;
  readonly tag: CacheTag;
  readonly relations: Readonly<Record<string, RelationManifest>>;
}

export interface ImplicitJoinTableManifest {
  readonly name: string;
  readonly schema: string;
  readonly relationName: string;
  readonly models: readonly [string, string];
  readonly tags: readonly CacheTag[];
}

export interface AtticTriggerManifest {
  readonly name: string;
  readonly schema: string;
  readonly table: string;
  readonly tags: readonly CacheTag[];
}

export interface AtticManifest<TClient = unknown> {
  readonly version: typeof ATTIC_MANIFEST_VERSION;
  readonly sqlAbiVersion: typeof ATTIC_SQL_ABI_VERSION;
  readonly namespace: string;
  readonly schemaChecksum: string;
  readonly models: Readonly<Record<string, ModelManifest>>;
  readonly implicitJoinTables: readonly ImplicitJoinTableManifest[];
  readonly triggers: readonly AtticTriggerManifest[];
  /** @internal Compile-time link to the generated Prisma client; never emitted at runtime. */
  readonly [ATTIC_CLIENT_TYPE]?: TClient;
}

export interface CacheStrategyOptions {
  readonly ttlMs?: number;
  readonly tags?: readonly CacheTag[];
}

export type CacheStrategy = false | CacheStrategyOptions;

export interface CacheDefaults {
  readonly ttlMs?: number;
  readonly negativeTtlMs?: number;
  readonly tags?: readonly CacheTag[];
}

export interface DisabledCachePolicy {
  readonly enabled: false;
}

export interface EnabledCachePolicy {
  readonly enabled: true;
  readonly ttlMs: number;
  readonly negativeTtlMs: number;
  readonly tags: readonly CacheTag[];
}

export type ResolvedCachePolicy = DisabledCachePolicy | EnabledCachePolicy;

export interface RedisSetOptions {
  readonly expiration?: {
    readonly type: "PX";
    readonly value: number;
  };
  readonly condition?: "NX" | "XX";
}

export interface RedisEvalOptions {
  readonly keys?: string[];
  readonly arguments?: string[];
}

/** The subset shared by node-redis clients and clusters that Attic uses. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, options?: RedisEvalOptions): Promise<unknown>;
  readonly isOpen?: boolean;
  readonly isReady?: boolean;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  close?(): Promise<unknown>;
  destroy?(): void;
  disconnect?(): void;
}

export interface AtticCodec {
  readonly version: string;
  encode(value: unknown): string;
  decode(encoded: string): unknown;
}

export interface DistributedLockOptions {
  readonly enabled?: boolean;
  readonly ttlMs?: number;
}

export interface WorkerOptions {
  readonly embedded?: boolean;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly maxBackoffMs?: number;
}

export type AtticEvent =
  | { readonly type: "engine.started" }
  | { readonly type: "engine.stopped" }
  | { readonly type: "cache.hit"; readonly key: string; readonly model?: string; readonly operation?: string }
  | { readonly type: "cache.miss"; readonly key: string; readonly model?: string; readonly operation?: string }
  | { readonly type: "cache.bypass"; readonly model?: string; readonly operation?: string; readonly reason: string }
  | { readonly type: "cache.error"; readonly operation: "read" | "write" | "delete"; readonly error: unknown }
  | { readonly type: "redis.error"; readonly error: unknown }
  | { readonly type: "write.committed"; readonly requestId: string }
  | { readonly type: "write.synchronized"; readonly requestId: string; readonly eventCount: number }
  | { readonly type: "write.error"; readonly requestId?: string; readonly committed: boolean; readonly error: unknown }
  | { readonly type: "worker.started" }
  | { readonly type: "worker.stopped" }
  | { readonly type: "worker.synchronized"; readonly eventCount: number; readonly tagCount: number }
  | { readonly type: "worker.error"; readonly error: unknown; readonly attempt: number };

export type AtticEventHandler = (event: AtticEvent) => void;

export interface AtticOptions<TClient = unknown> {
  readonly redis: RedisLike;
  readonly manifest: AtticManifest<TClient>;
  readonly ttlMs?: number;
  readonly negativeTtlMs?: number;
  readonly codec?: AtticCodec;
  readonly distributedLock?: boolean | DistributedLockOptions;
  readonly worker?: boolean | WorkerOptions;
  readonly onEvent?: AtticEventHandler;
}

export interface CacheKeyInput {
  readonly namespace: string;
  readonly scope?: unknown;
  readonly model: string;
  readonly operation: string;
  readonly args: unknown;
  readonly generations: Readonly<Record<CacheTag, TagGeneration>>;
}

export interface AtticOutboxHealth {
  readonly pendingEvents: number;
  readonly availableEvents: number;
  readonly leasedEvents: number;
  readonly maxAttempts: number;
  readonly oldestEventAgeMs?: number;
}

export interface AtticHealth {
  readonly started: boolean;
  readonly redis: "ready" | "unavailable";
  readonly database: "ready" | "unavailable";
  readonly schema: "current" | "missing" | "stale" | "unknown";
  readonly outbox?: AtticOutboxHealth;
  /** @deprecated Use `outbox.pendingEvents`. */
  readonly pendingOutboxEvents?: number;
}

export interface AtticTransactionOptions {
  readonly maxWait?: number;
  readonly timeout?: number;
  readonly isolationLevel?: "ReadUncommitted" | "ReadCommitted" | "RepeatableRead" | "Serializable";
}
