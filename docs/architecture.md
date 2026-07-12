# Architecture and consistency

Attic treats PostgreSQL as the only source of truth. Redis contains disposable query results and monotonic tag generations.

## Reads

Each cacheable Prisma read is associated with its top-level model and every related model referenced by its arguments. The generated manifest supplies relation metadata. The Redis key hashes the full query shape, values, scope, and current tag generations. A generation change makes every older key unreachable; TTL removes it later.

On a cache miss Attic queries PostgreSQL and writes the result under the generations observed before that query. A concurrent write may make that fill unreachable, but cannot make it visible under the newer generation. Redis failures and malformed cached values fall back to PostgreSQL.

## Writes

Generated PostgreSQL statement triggers increment durable model generations and append outbox events in the same transaction as application data. Writes initiated through Attic carry a transaction-local request ID. After commit, Attic finds those exact events and advances Redis generations before returning.

PostgreSQL and Redis do not share an atomic transaction. If PostgreSQL commits but Redis cannot be synchronized, Attic throws `AtticCommittedSyncError` with `committed === true`. Callers must not blindly retry that mutation. The outbox retains the invalidation for asynchronous repair.

Attic validates the generated SQL ABI and the live trigger name, table, enabled state, event type, namespace, and tags during startup and health checks. A model mutation that nevertheless commits without producing an outbox event durably attempts a global fallback invalidation and throws `AtticCommittedInstallationError`. Raw execute calls and read-only-capable interactive transactions cannot require an event because their SQL may legitimately affect no modeled table; live health validation remains the guard for those paths.

External writers receive no Attic error, but the same triggers enqueue their changes for the worker.

## Transactions

Cache access inside a database transaction could violate snapshot and read-your-writes semantics. `$attic.transaction()` therefore passes an uncached transaction client to the callback and synchronizes trigger events only after commit. The extended client's ordinary `$transaction` fails fast so batch-array or untracked transactions cannot silently weaken the guarantee.

## Worker delivery

Workers atomically lease pending events with `FOR UPDATE SKIP LOCKED`, group them by tag, update Redis monotonically, and acknowledge only after success. A crash may repeat an update but cannot move a generation backwards. Failed events are released with capped exponential backoff.

Startup compares Redis generations with durable PostgreSQL state before advancing anything. A Redis generation ahead of PostgreSQL usually indicates a point-in-time database restore, cross-environment namespace reuse, or operator corruption. Attic throws `AtticRecoveryRequiredError` rather than silently serving data from the newer Redis history. Rotate or completely purge that namespace before restart; see the operations guide.
