# Choosing a write strategy

“Write-through” and “write-behind” are often used for several different designs. This guide defines the terms precisely and explains why Attic implements only PostgreSQL-first cache coherence.

## Attic's contract

Attic performs cache-aside reads and PostgreSQL-first writes:

```text
Prisma mutation
    -> PostgreSQL data + durable tag generation + outbox event
    -> commit
    -> advance Redis generation
    -> acknowledge outbox event
```

The Redis write is invalidation metadata, not the mutated entity. PostgreSQL is always the source of truth. If Redis disappears, application data remains durable and reads can fall back to PostgreSQL.

This is sometimes called write-through invalidation, but it is not conventional value write-through.

## Conventional value write-through

Value write-through synchronously writes the same logical value to both the cache and database before reporting success.

```text
application -> cache value
            -> database value
            -> success after both
```

It works best for simple entity or key/value caches. Prisma queries can return arbitrary projections, relation graphs, aggregates, counts, and groups. One mutation cannot reliably rewrite every cached result shape that depends on it. Generation invalidation is therefore safer and more general than attempting to patch cached query results.

PostgreSQL and Redis also cannot participate in one atomic transaction. Any value write-through implementation must define what happens when one store succeeds and the other fails. Attic avoids making Redis authoritative and exposes the only unavoidable post-commit failure state through `AtticCommittedSyncError`.

## Write-behind

Write-behind acknowledges a command after placing it in Redis or another durable log, then persists it to PostgreSQL later.

```text
application -> durable command/log -> success
                                  -> worker batches/reduces commands
                                  -> PostgreSQL later
```

This can reduce write latency and database write frequency, but it changes fundamental application semantics:

- PostgreSQL is temporarily stale.
- Reads must decide whether to merge pending state.
- Commands need stable idempotency keys.
- Per-entity ordering and concurrency rules must be explicit.
- Queue loss, poison messages, retries, replay, and dead letters become data concerns.
- Domain-specific commands must define whether they commute or can be aggregated.

Those choices cannot be hidden safely behind an otherwise normal Prisma mutation.

## Why write-behind should be a separate project

Attic should not add a `writeBehind: true` option. The same Prisma call returning under two incompatible durability contracts would be difficult to reason about and easy to misuse.

If concrete workloads justify a reusable write engine, it should be a separate package or repository with an explicit command API. Its minimum responsibilities would be:

- a durable append mechanism such as Redis Streams, Kafka, or another acknowledged log;
- typed command schemas and versioning;
- mandatory idempotency and ordering keys;
- configurable batch reducers for commutative operations such as counters;
- idempotent PostgreSQL consumers and replay;
- retry, dead-letter, lag, and poison-command observability;
- explicit read-overlay behavior when PostgreSQL has not caught up;
- documented data-loss assumptions for Redis persistence and failover modes.

It should not claim transparent support for arbitrary Prisma mutations. A good first target would be one bounded workload—counters or interaction events—whose aggregation rules are understood and benchmarked.

Create that project only after at least one production use case can answer these questions:

1. What exact command is being buffered?
2. What ordering key does it use?
3. Can several commands be combined without changing meaning?
4. How stale may PostgreSQL be?
5. What does a read return while commands are pending?
6. What durability mode does the command log guarantee?
7. How is an operator expected to replay or discard a poison command?

Until then, a small domain-specific Redis/queue service is simpler and safer than a generic framework.

## Decision table

| Requirement                                 | Use Attic | Use a separate Redis service | Consider a write-behind project |
| ------------------------------------------- | --------- | ---------------------------- | ------------------------------- |
| Speed up repeated Prisma reads              | Yes       | No                           | No                              |
| Keep PostgreSQL authoritative               | Yes       | Sometimes                    | No, not immediately             |
| Capture external SQL writes                 | Yes       | Usually no                   | Not automatically               |
| Maintain geo/sorted-set/presence state      | No        | Yes                          | Usually no                      |
| Avoid PostgreSQL on every application write | No        | Sometimes                    | Yes                             |
| Batch thousands of counter increments       | No        | Possible                     | Yes                             |
| Preserve normal Prisma mutation semantics   | Yes       | Not applicable               | No                              |
| Require arbitrary domain aggregation        | No        | Yes                          | Yes                             |

For most applications, start with Attic plus a small explicit Redis service. Introduce write-behind only for a measured database bottleneck and only with a domain contract that makes delayed persistence safe.
