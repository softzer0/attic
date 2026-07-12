# Operations

Attic keeps PostgreSQL authoritative. Redis contains disposable query results and a copy of durable tag generations; the PostgreSQL outbox is the recovery boundary. Attic is not a Redis-first data-write buffer.

## Deployment topology

The embedded worker is suitable when at least one long-lived application instance is always running. Its timer is unreferenced, so it does not keep a process alive. Run a dedicated worker with `createAtticWorker()` when application instances scale to zero, deploy independently, or should not all poll PostgreSQL. Serverless deployments should invoke `runOnce()` from a scheduled job.

Multiple workers are safe: they lease rows with `FOR UPDATE SKIP LOCKED`, update Redis generations monotonically, and acknowledge only after Redis succeeds. Size `batchSize` and the number of worker processes from measured drain rate rather than request throughput alone.

## Hot-model write contention

Attic uses statement-level triggers, so one `createMany` statement does not enqueue one event per row. Every transaction that changes the same model must still serialize its durable generation update through one `attic.tag_state` row. This is necessary to keep generation order aligned with PostgreSQL commit order.

For write-heavy models:

- keep transactions short;
- mutate shared model sets in a consistent order where the application controls that order;
- treat PostgreSQL deadlock/serialization failures as whole-transaction failures and retry only through an application-level idempotent operation;
- compare ordinary Prisma and Attic throughput with `pnpm benchmark:writes` in the intended deployment topology;
- monitor cache hit rate as well as write latency, because frequent model-wide invalidation can make caching that model counterproductive;
- use `cacheStrategy: false` for volatile reads that do not earn back their cache and invalidation cost.

Bypassing a read does not remove table triggers: other cached queries may still depend on that model. Excluding models from durable invalidation would require proving that no cached relation or raw query depends on them, so Attic does not offer an unsafe trigger-bypass switch.

## Monitor the outbox

`prisma.$attic.health()` exposes structured outbox state:

```ts
const health = await prisma.$attic.health();

health.outbox?.pendingEvents;
health.outbox?.availableEvents;
health.outbox?.leasedEvents;
health.outbox?.oldestEventAgeMs;
health.outbox?.maxAttempts;

health.worker.lastSuccessAt;
health.worker.processedEvents;
health.worker.successfulBatches;
health.worker.failedBatches;
health.worker.retriedEvents;
```

Worker counters are process-local and reset on restart. Use `onEvent` or an external metrics system for durable time series. Monitor backlog age and retry state directly in PostgreSQL as well:

```sql
SELECT namespace,
       count(*) AS pending_events,
       extract(epoch FROM clock_timestamp() - min(created_at)) AS oldest_age_seconds,
       max(attempts) AS highest_attempts
  FROM attic.outbox
 GROUP BY namespace
 ORDER BY namespace;
```

Inspect events that repeatedly fail without selecting application data:

```sql
SELECT namespace,
       tag,
       attempts,
       available_at,
       locked_until,
       left(last_error, 500) AS last_error
  FROM attic.outbox
 WHERE attempts > 1
 ORDER BY attempts DESC, created_at
 LIMIT 100;
```

Alerting thresholds must follow the application's staleness and recovery objectives. A useful starting policy is:

- alert when the oldest event exceeds several worker poll intervals;
- page when oldest age exceeds the maximum accepted external-write staleness;
- alert on continuously increasing backlog even while Redis reports healthy;
- alert on repeated worker errors or attempts that continue increasing;
- capacity-plan from peak event creation rate versus measured worker drain rate.

Count and age are more useful together. A large but rapidly draining burst may be healthy, while one old event in a small backlog can identify a persistent failure.

## Prolonged Redis outage

During a Redis outage:

- cacheable reads fall back to PostgreSQL;
- an Attic-mediated write commits PostgreSQL first, leaves its durable outbox events pending, and throws `AtticCommittedSyncError` with `committed === true`;
- external PostgreSQL writers continue normally and enqueue events without receiving an Attic error;
- if Redis remains readable but generation writes fail, already-cached entries can remain visible to other processes until their generation is repaired.

Do not blindly retry `AtticCommittedSyncError`: the mutation already committed. Use an application idempotency key or read PostgreSQL before deciding whether another mutation is required.

Keep PostgreSQL capacity available for fallback reads and outbox growth. The worker already uses capped exponential backoff; restarting it repeatedly does not improve a Redis outage. Once Redis is healthy:

1. verify application reads can reach Redis;
2. start a dedicated worker or invoke `runOnce()` repeatedly;
3. watch oldest age and backlog trend toward zero;
4. verify `health()` reports Redis and schema readiness;
5. investigate any event whose attempts continue increasing.

Startup reconciliation copies all durable generations from `attic.tag_state` to Redis. This repairs evicted or completely lost Redis generation keys before ordinary caching resumes.

## Retention and dead-letter stance

Version 0.1 deletes an outbox event after Redis accepts its generation. Failed events remain durable and retry indefinitely with capped exponential backoff. There is no automatic maximum-attempt cutoff, dead-letter table, or time-based deletion of pending events.

Do not apply a generic retention policy to `attic.outbox`, and do not truncate `attic.tag_state`. Deleting a pending event before Redis has advanced can make an old cache generation reachable. If an event appears poisoned, first correct the Redis/configuration problem and let the monotonic worker process it. Any manual quarantine procedure must prove that Redis already contains an equal or greater generation for that tag before removing the event.

Successful events are removed automatically, so a healthy outbox does not require routine vacuum-by-age jobs beyond normal PostgreSQL autovacuum. High sustained write rates may justify database-specific autovacuum tuning after observing table churn.

## Backup and restore

Treat PostgreSQL metadata in the `attic` schema as part of the application backup. After restoring PostgreSQL while Redis is empty, start Attic normally: startup reconciliation restores generations and the worker drains pending events.

A point-in-time PostgreSQL restore while retaining newer Redis contents is different. Redis may contain query values created after the restored database snapshot, and monotonic generation scripts intentionally do not move generations backwards. Startup detects Redis generations ahead of PostgreSQL and fails with `AtticRecoveryRequiredError` instead of silently accepting the divergence. Before serving traffic, either purge every Redis key for the affected Attic namespace or deploy a new namespace with the coordinated migration procedure below. Rotating the namespace is safer when complete key removal cannot be proven.

After a restore, validate:

- the installed manifest checksum matches the deployed generated manifest;
- the expected table triggers exist;
- `attic.tag_state` and `attic.outbox` were restored;
- Redis generations were reconciled or the namespace was rotated;
- backlog age is decreasing.

## Namespace changes

The namespace is a persisted protocol boundary, not a cosmetic key prefix. Changing it changes Redis keys, installation metadata, trigger arguments, and the schema checksum.

Use a coordinated change:

1. stop old application writers and workers;
2. drain and verify the old namespace outbox;
3. update the Prisma generator namespace;
4. generate and review a new Attic migration;
5. apply the migration, which installs the new namespace and the retirement helper;
6. before admitting writers, retire the old triggers and PostgreSQL metadata with `SELECT attic.retire_namespace('old-namespace')`;
7. deploy the new manifest/runtime;
8. allow old result keys to expire, and explicitly remove persistent old generation keys according to the Redis operational policy.

Generated SQL can install and reconcile the current namespace, but it cannot infer which historical namespace is safe to retire. `attic.retire_namespace()` must therefore be an explicit operator action. Review the generated migration that introduced the helper before first use, and do not retire a namespace until its outbox is empty. Do not leave both trigger sets active indefinitely: each database statement would enqueue invalidations for both namespaces.

## SQL ABI upgrades

Attic's trigger functions and outbox functions live once in the database and are shared by every namespace. A migration that advances the SQL ABI marks every installed namespace with the new ABI so an older runtime fails validation instead of silently using incompatible global functions.

Coordinate an ABI-changing package upgrade across every application that uses the same PostgreSQL database:

1. generate and review the Attic-only migration created by `attic migrate dev --create-only`;
2. stop or drain writers using older Attic runtimes;
3. apply the migration;
4. regenerate and migrate each remaining namespace;
5. deploy runtimes generated for the new ABI;
6. confirm live trigger and schema health before restoring traffic.

Ordinary application schema migrations that leave the ABI unchanged do not require cross-namespace deployment coordination.

## Write benchmark

The opt-in harness compares a plain Prisma/PostgreSQL schema with an isolated Attic-instrumented schema. It measures sequential creates, concurrent updates across many rows of one hot model, `createMany` batches, commit-to-Redis/outbox-ack latency, and final backlog.

`benchmark:writes` is a maintainer tool for an Attic source checkout. Its benchmark source and generated test fixture are intentionally not included in the npm tarball, so this command is not available from an installed `prisma-extension-attic` package.

Run it against disposable or dedicated test services:

```sh
ATTIC_BENCH_CONFIRM=1 DATABASE_URL=postgresql://... REDIS_URL=redis://... pnpm benchmark:writes
```

PowerShell:

```powershell
$env:DATABASE_URL = "postgresql://..."
$env:REDIS_URL = "redis://..."
$env:ATTIC_BENCH_CONFIRM = "1"
pnpm benchmark:writes
```

`ATTIC_BENCH_CONFIRM=1` is mandatory because the harness creates PostgreSQL objects and generates sustained write load. Optional controls:

| Variable                        | Default | Meaning                                        |
| ------------------------------- | ------: | ---------------------------------------------- |
| `ATTIC_BENCH_SEQUENTIAL_WRITES` |     100 | Single-operation create samples                |
| `ATTIC_BENCH_CONCURRENT_WRITES` |     500 | Hot-model update samples                       |
| `ATTIC_BENCH_CONCURRENCY`       |      16 | Concurrent update runners                      |
| `ATTIC_BENCH_BULK_ROWS`         |    5000 | Rows inserted by bulk scenarios                |
| `ATTIC_BENCH_BULK_BATCH_SIZE`   |     500 | Rows per `createMany` statement                |
| `ATTIC_BENCH_WARMUP_WRITES`     |      10 | Unmeasured connection warmup writes            |
| `ATTIC_BENCH_OUTPUT`            |   table | Set to `json` for machine-readable output only |

The harness creates unique schemas and a unique Redis namespace, installs the current Attic SQL helpers, then cleans up its schemas, namespace metadata, and observed Redis keys. Run it only against disposable or dedicated benchmark services, not a production database. It is deliberately not a CI threshold test. Results are sensitive to network distance, PostgreSQL/Redis sizing, pool limits, durability settings, noisy neighbors, and database warmup.

Interpret the scenarios separately:

- sequential create shows fixed per-write transaction, outbox, Redis, and acknowledgement cost;
- hot-model concurrency exposes contention on one model generation even though different entity rows are updated;
- bulk insertion demonstrates the benefit of statement-level triggers and should be evaluated in rows per second;
- post-commit synchronization measures outbox lookup, monotonic Redis generation updates, and acknowledgement after PostgreSQL has committed;
- nonzero final backlog means the run did not reach the expected synchronized steady state and should not be used for comparison.

Run several repetitions near the intended deployment topology and compare distributions, not a single throughput number. Do not infer production capacity from localhost results.
