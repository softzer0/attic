import { buildTagGenerationKey } from "../../src/core/canonical.js";
import type { AtticManifest, RedisEvalOptions, RedisLike, RedisSetOptions } from "../../src/core/types.js";
import type { PrismaRawClient, TransactionOptions } from "../../src/database.js";

export const TEST_MANIFEST: AtticManifest = {
  version: 1,
  sqlAbiVersion: 1,
  namespace: "test-attic",
  schemaChecksum: "test-checksum",
  models: {
    Post: {
      name: "Post",
      dbName: "posts",
      schema: "public",
      tag: "model:Post",
      relations: {
        author: {
          field: "author",
          model: "User",
          isList: false,
          dependencies: ["model:User"],
        },
      },
    },
    User: {
      name: "User",
      dbName: "users",
      schema: "public",
      tag: "model:User",
      relations: {
        posts: {
          field: "posts",
          model: "Post",
          isList: true,
          dependencies: ["model:Post"],
        },
      },
    },
  },
  implicitJoinTables: [],
  triggers: [
    { name: "attic_test_posts", schema: "public", table: "posts", tags: ["model:Post"] },
    { name: "attic_test_users", schema: "public", table: "users", tags: ["model:User"] },
  ],
};

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left.localeCompare(right);
}

export class FakeRedis implements RedisLike {
  public readonly values = new Map<string, string>();
  public readonly getCalls: string[] = [];
  public readonly setCalls: { readonly key: string; readonly options?: RedisSetOptions }[] = [];
  public readonly evalCalls: { readonly script: string; readonly options?: RedisEvalOptions }[] = [];
  public getError: Error | undefined;
  public setError: Error | undefined;
  public evalError: Error | undefined;

  public get(key: string): Promise<string | null> {
    this.getCalls.push(key);
    if (this.getError !== undefined) return Promise.reject(this.getError);
    return Promise.resolve(this.values.get(key) ?? null);
  }

  public set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    this.setCalls.push({ key, ...(options === undefined ? {} : { options }) });
    if (this.setError !== undefined) return Promise.reject(this.setError);
    if (options?.condition === "NX" && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  public del(key: string): Promise<number> {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }

  public eval(script: string, options?: RedisEvalOptions): Promise<unknown> {
    this.evalCalls.push({ script, ...(options === undefined ? {} : { options }) });
    if (this.evalError !== undefined) return Promise.reject(this.evalError);

    const key = options?.keys?.[0];
    if (key === undefined) return Promise.reject(new Error("Expected one Redis script key."));

    if (script.includes("local incoming")) {
      const incoming = options?.arguments?.[0];
      if (incoming === undefined) return Promise.reject(new Error("Expected an incoming generation."));
      const current = this.values.get(key);
      if (current === undefined || compareDecimal(incoming, current) > 0) this.values.set(key, incoming);
      return Promise.resolve(this.values.get(key));
    }

    if (script.includes("local digits")) {
      const next = (BigInt(this.values.get(key) ?? "0") + 1n).toString();
      this.values.set(key, next);
      return Promise.resolve(next);
    }

    if (script.includes("redis.call('DEL'")) {
      this.values.delete(key);
      return Promise.resolve(1);
    }

    return Promise.reject(new Error("Unexpected Redis script."));
  }

  public generation(tag: string): string | undefined {
    return this.values.get(buildTagGenerationKey(TEST_MANIFEST.namespace, tag));
  }

  public cacheKeys(): readonly string[] {
    return [...this.values.keys()].filter((key) => key.startsWith(`${TEST_MANIFEST.namespace}:cache:`));
  }
}

interface FakeOutboxRow {
  readonly id: string;
  readonly namespace: string;
  readonly tag: string;
  readonly generation: string;
  readonly request_id: string | null;
  readonly attempts: number;
}

export interface FakeTriggerRow {
  readonly trigger_name: string;
  readonly table_schema: string;
  readonly table_name: string;
  readonly enabled: string;
  readonly trigger_type: number;
  readonly arguments_hex: string;
}

function triggerArgumentsHex(namespace: string, tags: readonly string[]): string {
  return Buffer.from(`${[namespace, ...tags].join("\0")}\0`, "utf8").toString("hex");
}

export class FakePrismaRawClient implements PrismaRawClient {
  public installationChecksum: string | null = TEST_MANIFEST.schemaChecksum;
  public installationSqlAbiVersion: number | null = TEST_MANIFEST.sqlAbiVersion;
  public liveTriggers: FakeTriggerRow[] = TEST_MANIFEST.triggers.map((trigger) => ({
    trigger_name: trigger.name,
    table_schema: trigger.schema,
    table_name: trigger.table,
    enabled: "O",
    trigger_type: 60,
    arguments_hex: triggerArgumentsHex(TEST_MANIFEST.namespace, trigger.tags),
  }));
  public queryError: Error | undefined;
  public readonly generations = new Map<string, string>();
  public readonly outbox: FakeOutboxRow[] = [];
  public readonly queryCalls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
  public readonly executeCalls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
  public readonly batchTransactions: (readonly unknown[])[] = [];
  public readonly transactionOptions: (TransactionOptions | undefined)[] = [];
  public writeTags: readonly string[] = ["$attic:all", "model:User"];
  public lastRequestId: string | undefined;
  public released:
    | { readonly workerId: string; readonly ids: readonly string[]; readonly backoffMs: number; readonly error: string }
    | undefined;
  private nextEventId = 1;

  public async $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> {
    await Promise.resolve();
    this.queryCalls.push({ sql, values });
    if (this.queryError !== undefined) throw this.queryError;

    if (sql.includes("set_config('attic.request_id'")) {
      this.lastRequestId = String(values[0]);
      return [] as T;
    }

    if (sql.includes("FROM attic.installation")) {
      const rows =
        this.installationChecksum === null
          ? []
          : [{ manifest_hash: this.installationChecksum, sql_abi_version: this.installationSqlAbiVersion }];
      return rows as T;
    }

    if (sql.includes("FROM pg_catalog.pg_trigger")) return this.liveTriggers as T;

    if (sql.includes("FROM attic.enqueue_tags")) {
      const namespace = String(values[0]);
      const tags = values[1] as readonly string[];
      const requestId = String(values[2]);
      const rows = this.addEvents(namespace, requestId, tags);
      return rows as T;
    }

    if (sql.includes("FROM attic.outbox") && sql.includes("request_id =")) {
      const namespace = String(values[0]);
      const requestId = String(values[1]);
      return this.outbox.filter((row) => row.namespace === namespace && row.request_id === requestId) as T;
    }

    if (sql.includes("WITH candidates AS")) {
      const namespace = String(values[0]);
      const batchSize = Number(values[1]);
      const rows = this.outbox
        .filter((row) => row.namespace === namespace)
        .slice(0, batchSize)
        .map((row) => ({ ...row, attempts: row.attempts + 1 }));
      return rows as T;
    }

    if (sql.includes("FROM attic.tag_state") && sql.includes("tag = ANY")) {
      const tags = values[1] as readonly string[];
      return tags.flatMap((tag) => {
        const generation = this.generations.get(tag);
        return generation === undefined ? [] : [{ tag, generation }];
      }) as T;
    }

    if (sql.includes("FROM attic.tag_state")) {
      return [...this.generations].map(([tag, generation]) => ({ tag, generation })) as T;
    }

    if (sql.includes("pending_events") && sql.includes("attic.outbox")) {
      const attempts = this.outbox.map((event) => event.attempts);
      return [
        {
          pending_events: this.outbox.length.toString(),
          available_events: this.outbox.length.toString(),
          leased_events: "0",
          max_attempts: attempts.length === 0 ? null : Math.max(...attempts).toString(),
          oldest_event_age_ms: this.outbox.length === 0 ? null : "0",
        },
      ] as T;
    }

    return [] as T;
  }

  public async $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> {
    await Promise.resolve();
    this.executeCalls.push({ sql, values });

    if (sql.includes("DELETE FROM attic.outbox")) {
      const ids = new Set((values[1] as readonly string[]).map(String));
      let removed = 0;
      for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
        const row = this.outbox[index];
        if (row !== undefined && ids.has(row.id)) {
          this.outbox.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    }

    if (sql.includes("UPDATE attic.outbox")) {
      this.released = {
        workerId: String(values[2]),
        ids: values[1] as readonly string[],
        backoffMs: Number(values[3]),
        error: String(values[4]),
      };
    }

    return 0;
  }

  public $transaction<T>(queries: readonly unknown[]): Promise<T>;
  public $transaction<T>(
    callback: (transaction: PrismaRawClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
  public async $transaction<T>(
    input: readonly unknown[] | ((transaction: PrismaRawClient) => Promise<T>),
    options?: TransactionOptions,
  ): Promise<T> {
    this.transactionOptions.push(options);
    if (Array.isArray(input)) {
      this.batchTransactions.push(input);
      const result = await Promise.all(input);
      if (this.lastRequestId !== undefined) {
        this.addEvents(TEST_MANIFEST.namespace, this.lastRequestId, this.writeTags);
      }
      return result as T;
    }

    const callback = input as (transaction: PrismaRawClient) => Promise<T>;
    const result = await callback(this);
    if (this.lastRequestId !== undefined) {
      this.addEvents(TEST_MANIFEST.namespace, this.lastRequestId, this.writeTags);
    }
    return result;
  }

  private addEvents(namespace: string, requestId: string, tags: readonly string[]): FakeOutboxRow[] {
    return tags.map((tag) => {
      const generation = (BigInt(this.generations.get(tag) ?? "0") + 1n).toString();
      this.generations.set(tag, generation);
      const row: FakeOutboxRow = {
        id: String(this.nextEventId++),
        namespace,
        tag,
        generation,
        request_id: requestId,
        attempts: 0,
      };
      this.outbox.push(row);
      return row;
    });
  }
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
    reject(reason) {
      if (rejectPromise === undefined) throw new Error("Deferred promise was not initialized.");
      rejectPromise(reason);
    },
  };
}
