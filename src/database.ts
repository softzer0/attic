import { randomUUID } from "node:crypto";

import { AtticInstallationError, AtticSchemaMismatchError } from "./core/errors.js";
import type { AtticManifest, AtticOutboxHealth, AtticTransactionOptions, AtticTriggerManifest } from "./core/types.js";

export interface PrismaRawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $transaction<T>(queries: readonly unknown[]): Promise<T>;
  $transaction<T>(
    callback: (transaction: PrismaRawClient) => Promise<T>,
    options?: AtticTransactionOptions,
  ): Promise<T>;
}

export type TransactionOptions = AtticTransactionOptions;

export interface OutboxEvent {
  readonly id: string;
  readonly namespace: string;
  readonly tag: string;
  readonly generation: string;
  readonly requestId: string | null;
  readonly attempts: number;
}

interface InstallationRow {
  readonly manifest_hash: string;
  readonly sql_abi_version: number | string;
}

interface TriggerRow {
  readonly trigger_name: string;
  readonly table_schema: string;
  readonly table_name: string;
  readonly enabled: string;
  readonly trigger_type: number | string;
  readonly arguments_hex: string;
}

interface GenerationRow {
  readonly tag: string;
  readonly generation: string | bigint | number;
}

interface OutboxRow {
  readonly id: string | bigint | number;
  readonly namespace: string;
  readonly tag: string;
  readonly generation: string | bigint | number;
  readonly request_id: string | null;
  readonly attempts: number;
}

interface OutboxHealthRow {
  readonly pending_events: string | bigint | number;
  readonly available_events: string | bigint | number;
  readonly leased_events: string | bigint | number;
  readonly max_attempts: string | bigint | number | null;
  readonly oldest_event_age_ms: string | bigint | number | null;
}

const SET_REQUEST_CONTEXT_SQL = "SELECT set_config('attic.request_id', $1, true)";
const MISSING_INSTALLATION_CODES = new Set(["3F000", "42P01", "P2021"]);
const STALE_INSTALLATION_CODES = new Set(["42703"]);
const EXPECTED_TRIGGER_TYPE = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingInstallationError(error: unknown, visited = new WeakSet<object>()): boolean {
  return hasPostgresCode(error, MISSING_INSTALLATION_CODES, visited);
}

function hasPostgresCode(error: unknown, expected: ReadonlySet<string>, visited = new WeakSet<object>()): boolean {
  if (!isRecord(error) || visited.has(error)) return false;
  visited.add(error);

  const meta = isRecord(error.meta) ? error.meta : undefined;
  const codes = [error.code, meta?.code];
  if (codes.some((code) => typeof code === "string" && expected.has(code))) return true;
  return hasPostgresCode(error.cause, expected, visited);
}

function triggerKey(trigger: Pick<AtticTriggerManifest, "name" | "schema" | "table">): string {
  return `${trigger.schema}\0${trigger.table}\0${trigger.name}`;
}

function triggerArguments(row: TriggerRow): readonly string[] {
  const encoded = Buffer.from(row.arguments_hex, "hex").toString("utf8");
  return encoded.endsWith("\0") ? encoded.slice(0, -1).split("\0") : encoded.split("\0");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonNegativeNumber(value: string | bigint | number | null, field: string): number {
  const normalized = Number(value ?? 0);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`PostgreSQL returned an invalid Attic ${field}.`);
  }
  return normalized;
}

function normalizeEvent(row: OutboxRow): OutboxEvent {
  return {
    id: String(row.id),
    namespace: row.namespace,
    tag: row.tag,
    generation: String(row.generation),
    requestId: row.request_id,
    attempts: row.attempts,
  };
}

export class AtticDatabase {
  public readonly namespace: string;
  private readonly manifestHash: string;
  private readonly sqlAbiVersion: number;
  private readonly expectedTriggers: readonly AtticTriggerManifest[];

  public constructor(
    private readonly client: PrismaRawClient,
    manifest: Pick<AtticManifest, "namespace" | "schemaChecksum" | "sqlAbiVersion" | "triggers">,
  ) {
    this.namespace = manifest.namespace;
    this.manifestHash = manifest.schemaChecksum;
    this.sqlAbiVersion = manifest.sqlAbiVersion;
    this.expectedTriggers = manifest.triggers;
  }

  public async validateSchema(): Promise<void> {
    let rows: InstallationRow[];

    try {
      rows = await this.client.$queryRawUnsafe<InstallationRow[]>(
        `SELECT manifest_hash, sql_abi_version
           FROM attic.installation
          WHERE namespace = $1`,
        this.namespace,
      );
    } catch (cause) {
      if (isMissingInstallationError(cause)) {
        throw new AtticSchemaMismatchError(this.manifestHash, null, { cause });
      }
      if (hasPostgresCode(cause, STALE_INSTALLATION_CODES)) {
        throw new AtticInstallationError(
          ["The installed Attic metadata predates SQL ABI validation; apply a generated Attic migration."],
          { cause },
        );
      }
      throw cause;
    }

    const actualHash = rows[0]?.manifest_hash;
    if (actualHash !== this.manifestHash) {
      throw new AtticSchemaMismatchError(this.manifestHash, actualHash ?? null);
    }

    const actualAbi = Number(rows[0]?.sql_abi_version);
    if (!Number.isSafeInteger(actualAbi) || actualAbi !== this.sqlAbiVersion) {
      throw new AtticInstallationError([
        `Expected SQL ABI ${String(this.sqlAbiVersion)}, received ${Number.isNaN(actualAbi) ? "missing" : String(actualAbi)}.`,
      ]);
    }

    await this.validateTriggers();
  }

  private async validateTriggers(): Promise<void> {
    let rows: TriggerRow[];
    try {
      rows = await this.client.$queryRawUnsafe<TriggerRow[]>(
        `SELECT trg.tgname AS trigger_name,
                rel_schema.nspname AS table_schema,
                rel.relname AS table_name,
                trg.tgenabled::text AS enabled,
                trg.tgtype::integer AS trigger_type,
                encode(trg.tgargs, 'hex') AS arguments_hex
           FROM pg_catalog.pg_trigger AS trg
           JOIN pg_catalog.pg_proc AS fn ON fn.oid = trg.tgfoid
           JOIN pg_catalog.pg_namespace AS fn_schema ON fn_schema.oid = fn.pronamespace
           JOIN pg_catalog.pg_class AS rel ON rel.oid = trg.tgrelid
           JOIN pg_catalog.pg_namespace AS rel_schema ON rel_schema.oid = rel.relnamespace
          WHERE NOT trg.tgisinternal
            AND fn_schema.nspname = 'attic'
            AND fn.proname = 'capture_statement'`,
      );
    } catch (cause) {
      throw new AtticInstallationError(["Unable to inspect the live Attic trigger installation."], { cause });
    }

    const expectedKeys = new Set(this.expectedTriggers.map(triggerKey));
    const relevantRows = rows.filter((row) => {
      const actualArguments = triggerArguments(row);
      const rowKey = triggerKey({ name: row.trigger_name, schema: row.table_schema, table: row.table_name });
      return actualArguments[0] === this.namespace || expectedKeys.has(rowKey);
    });
    const actualByKey = new Map(
      relevantRows.map((row) => [
        triggerKey({ name: row.trigger_name, schema: row.table_schema, table: row.table_name }),
        row,
      ]),
    );
    const issues: string[] = [];

    for (const expected of this.expectedTriggers) {
      const key = triggerKey(expected);
      const actual = actualByKey.get(key);
      if (actual === undefined) {
        issues.push(
          `Missing trigger ${JSON.stringify(expected.name)} on ${JSON.stringify(`${expected.schema}.${expected.table}`)}.`,
        );
        continue;
      }

      actualByKey.delete(key);
      if (actual.enabled !== "O" && actual.enabled !== "A") {
        issues.push(`Trigger ${JSON.stringify(expected.name)} is not enabled for ordinary writes.`);
      }
      if (Number(actual.trigger_type) !== EXPECTED_TRIGGER_TYPE) {
        issues.push(`Trigger ${JSON.stringify(expected.name)} is not an AFTER statement trigger for all write events.`);
      }
      const expectedArguments = [this.namespace, ...expected.tags];
      const actualArguments = triggerArguments(actual);
      if (!sameStrings(actualArguments, expectedArguments)) {
        issues.push(
          `Trigger ${JSON.stringify(expected.name)} arguments differ: expected ${JSON.stringify(expectedArguments)}, received ${JSON.stringify(actualArguments)}.`,
        );
      }
    }

    for (const unexpected of actualByKey.values()) {
      issues.push(
        `Unexpected trigger ${JSON.stringify(unexpected.trigger_name)} on ${JSON.stringify(`${unexpected.table_schema}.${unexpected.table_name}`)} remains installed for namespace ${JSON.stringify(this.namespace)}.`,
      );
    }

    if (issues.length > 0) throw new AtticInstallationError(issues);
  }

  public async runWrite<T>(query: PromiseLike<T>): Promise<{ readonly requestId: string; readonly result: T }> {
    const requestId = randomUUID();
    const context = this.client.$queryRawUnsafe<readonly unknown[]>(SET_REQUEST_CONTEXT_SQL, requestId);
    const transactionResult = await this.client.$transaction<readonly [unknown, T]>([context, query]);

    return { requestId, result: transactionResult[1] };
  }

  public async runTransaction<T>(
    callback: (transaction: PrismaRawClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<{ readonly requestId: string; readonly result: T }> {
    const requestId = randomUUID();
    const result = await this.client.$transaction(async (transaction) => {
      await transaction.$queryRawUnsafe(SET_REQUEST_CONTEXT_SQL, requestId);
      return callback(transaction);
    }, options);

    return { requestId, result };
  }

  public async requestEvents(requestId: string): Promise<OutboxEvent[]> {
    const rows = await this.client.$queryRawUnsafe<OutboxRow[]>(
      `SELECT id::text AS id,
              namespace,
              tag,
              generation::text AS generation,
              request_id::text AS request_id,
              attempts
         FROM attic.outbox
        WHERE namespace = $1
          AND request_id = $2::uuid
        ORDER BY id`,
      this.namespace,
      requestId,
    );

    return rows.map(normalizeEvent);
  }

  public async enqueueTags(tags: readonly string[], requestId: string = randomUUID()): Promise<OutboxEvent[]> {
    const rows = await this.client.$queryRawUnsafe<OutboxRow[]>(
      `SELECT id::text AS id,
              namespace,
              tag,
              generation::text AS generation,
              request_id::text AS request_id,
              attempts
         FROM attic.enqueue_tags($1, $2::text[], $3::uuid)`,
      this.namespace,
      [...new Set(tags)].sort(),
      requestId,
    );

    return rows.map(normalizeEvent);
  }

  public async loadGenerations(tags: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (tags.length === 0) return new Map();

    const rows = await this.client.$queryRawUnsafe<GenerationRow[]>(
      `SELECT tag, generation::text AS generation
         FROM attic.tag_state
        WHERE namespace = $1
          AND tag = ANY($2::text[])`,
      this.namespace,
      [...new Set(tags)],
    );

    const result = new Map<string, string>();
    for (const tag of tags) result.set(tag, "0");
    for (const row of rows) result.set(row.tag, String(row.generation));
    return result;
  }

  public async loadAllGenerations(): Promise<ReadonlyMap<string, string>> {
    const rows = await this.client.$queryRawUnsafe<GenerationRow[]>(
      `SELECT tag, generation::text AS generation
         FROM attic.tag_state
        WHERE namespace = $1`,
      this.namespace,
    );

    return new Map(rows.map((row) => [row.tag, String(row.generation)]));
  }

  public async claimEvents(workerId: string, batchSize: number, leaseMs: number): Promise<OutboxEvent[]> {
    const rows = await this.client.$queryRawUnsafe<OutboxRow[]>(
      `WITH candidates AS (
         SELECT id
           FROM attic.outbox
          WHERE namespace = $1
            AND available_at <= clock_timestamp()
            AND (locked_until IS NULL OR locked_until < clock_timestamp())
          ORDER BY id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE attic.outbox AS event
          SET locked_by = $3::uuid,
              locked_until = clock_timestamp() + ($4::double precision * interval '1 millisecond'),
              attempts = event.attempts + 1
         FROM candidates
        WHERE event.id = candidates.id
       RETURNING event.id::text AS id,
                 event.namespace,
                 event.tag,
                 event.generation::text AS generation,
                 event.request_id::text AS request_id,
                 event.attempts`,
      this.namespace,
      batchSize,
      workerId,
      leaseMs,
    );

    return rows.map(normalizeEvent);
  }

  public async acknowledgeEvents(workerId: string | null, eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;

    await this.client.$executeRawUnsafe(
      `DELETE FROM attic.outbox
        WHERE namespace = $1
          AND id = ANY($2::bigint[])
          AND ($3::uuid IS NULL OR locked_by = $3::uuid OR locked_by IS NULL)`,
      this.namespace,
      [...eventIds],
      workerId,
    );
  }

  public async releaseEvents(
    workerId: string,
    eventIds: readonly string[],
    backoffMs: number,
    error: unknown,
  ): Promise<void> {
    if (eventIds.length === 0) return;

    const message = error instanceof Error ? error.message : String(error);
    await this.client.$executeRawUnsafe(
      `UPDATE attic.outbox
          SET locked_by = NULL,
              locked_until = NULL,
              available_at = clock_timestamp() + ($4::double precision * interval '1 millisecond'),
              last_error = left($5, 2000)
        WHERE namespace = $1
          AND id = ANY($2::bigint[])
          AND locked_by = $3::uuid`,
      this.namespace,
      [...eventIds],
      workerId,
      backoffMs,
      message,
    );
  }

  public async backlogSize(): Promise<number> {
    return (await this.outboxHealth()).pendingEvents;
  }

  public async outboxHealth(): Promise<AtticOutboxHealth> {
    const rows = await this.client.$queryRawUnsafe<OutboxHealthRow[]>(
      `SELECT count(*)::text AS pending_events,
              (count(*) FILTER (
                WHERE available_at <= clock_timestamp()
                  AND (locked_until IS NULL OR locked_until < clock_timestamp())
              ))::text AS available_events,
              (count(*) FILTER (
                WHERE locked_by IS NOT NULL
                  AND locked_until >= clock_timestamp()
              ))::text AS leased_events,
              max(attempts)::text AS max_attempts,
              floor(
                extract(epoch FROM (clock_timestamp() - min(created_at))) * 1000
              )::bigint::text AS oldest_event_age_ms
         FROM attic.outbox
        WHERE namespace = $1`,
      this.namespace,
    );
    const row = rows[0];
    if (row === undefined) throw new TypeError("PostgreSQL returned no Attic outbox health row.");

    const pendingEvents = nonNegativeNumber(row.pending_events, "pending event count");
    const oldestEventAgeMs =
      row.oldest_event_age_ms === null ? undefined : nonNegativeNumber(row.oldest_event_age_ms, "oldest event age");
    return {
      pendingEvents,
      availableEvents: nonNegativeNumber(row.available_events, "available event count"),
      leasedEvents: nonNegativeNumber(row.leased_events, "leased event count"),
      maxAttempts: nonNegativeNumber(row.max_attempts, "maximum attempt count"),
      ...(oldestEventAgeMs === undefined ? {} : { oldestEventAgeMs }),
    };
  }
}
