# Attic

Attic is a type-safe Prisma Client extension that keeps PostgreSQL authoritative while using Redis for automatic cache-aside reads. PostgreSQL triggers persist model-tagged invalidations in an outbox, so Redis can be repaired after an outage or process crash.

```ts
const user = await prisma.user.findUnique({ where: { id } }); // Redis -> PostgreSQL on miss
await prisma.user.update({ where: { id }, data: { name: "Ada" } }); // PostgreSQL -> durable invalidation -> Redis
```

Attic targets Prisma 7, PostgreSQL, Node.js 22.12+, and Redis 7.2+. It ships ESM and CommonJS builds plus an optional NestJS module.

> Attic does not implement conventional value write-through or write-behind. A committed PostgreSQL mutation synchronously advances Redis invalidation generations, backed by a durable PostgreSQL outbox; it does not mirror arbitrary Prisma result shapes during writes.

Use Attic when PostgreSQL must remain authoritative and Redis may be discarded. It is designed for repeated Prisma reads whose results need reliable invalidation after application, raw SQL, cascade, or external writes. It is not a Redis-first write buffer, queue, counter store, presence system, or general replacement for Redis-native domain state. See [choosing a write strategy](docs/write-strategies.md) before applying Attic to a write-heavy workload.

New to Attic? Follow the copyable [examples and recipes](docs/examples.md) from basic setup through transactions, RLS scopes, raw queries, NestJS, failure handling, and dedicated workers.

## Installation

In an existing Prisma 7 PostgreSQL project, install Attic and Redis:

```sh
pnpm add prisma-extension-attic redis
```

Add the Attic generator to `prisma/schema.prisma` beside your existing Prisma Client generator:

```prisma
generator attic {
  provider  = "attic-generator"
  output    = "../src/generated/attic"
  namespace = "my-api"
}
```

Create and apply the migration through Attic's Prisma wrapper:

```sh
pnpm exec attic migrate dev --name install_attic
```

This command runs every configured Prisma generator, adds Attic's trigger and outbox SQL to the migration, and applies it. It also creates `src/generated/attic/manifest.ts`, which exports the schema-specific `atticManifest` used by the extension:

```ts
import { atticManifest } from "./generated/attic/manifest.js";
```

Do not create or edit `atticManifest` yourself. It contains the generated model, relation, cache-tag, checksum, and trigger metadata that binds Attic to this Prisma schema.

Use `attic migrate dev` in place of `prisma migrate dev` for later schema changes. For a new Prisma project, custom output paths, migration review, and deployment commands, see the [complete setup examples](docs/examples.md) and [migration guide](docs/migrations.md).

## Usage

Extend the Prisma client your application already owns:

```ts
import { createClient } from "redis";

import { withAttic } from "prisma-extension-attic";
import { atticManifest } from "./generated/attic/manifest.js";
import { prisma as basePrisma } from "./prisma.js";

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (error) => console.error("Redis error", error));
await redis.connect();

const prisma = basePrisma.$extends(withAttic({ redis, manifest: atticManifest }));

await prisma.$attic.start();

const users = await prisma.user.findMany({
  where: { posts: { some: { published: true } } },
});
```

The following operations cache automatically with their normal Prisma argument and result types:

- `findUnique` and `findUniqueOrThrow`
- `findFirst` and `findFirstOrThrow`
- `findMany`
- `count`, `aggregate`, and `groupBy`

The default TTL is five minutes. `null` and `undefined` results use a five-second negative TTL. Empty arrays, `false`, and zero are normal cached values.

### Per-query policy

```ts
await prisma.user.findMany({
  where: { active: true },
  cacheStrategy: { ttlMs: 30_000, tags: ["active-users"] },
});

await prisma.user.findUnique({
  where: { id },
  cacheStrategy: false,
});
```

Automatic tags cover the top-level model and related models referenced by `where`, `select`, `include`, `omit`, or ordering arguments. Manual tags supplement those dependencies and are invalidated through `$attic.invalidate()`.

### Transactions

Use Attic’s callback transaction helper. It passes an uncached transaction client to preserve snapshots and read-your-writes behavior, and synchronizes trigger events only after commit.

```ts
await prisma.$attic.transaction(
  async (tx) => {
    const user = await tx.user.create({ data: { email } });
    await tx.profile.create({ data: { userId: user.id } });
    return user;
  },
  { isolationLevel: "Serializable" },
);
```

The extended client’s ordinary `$transaction` throws before doing work. Batch-array transactions are not supported in v0.1.

### Tenant and RLS scope

Apply Attic after authorization, tenant, or query-shaping extensions. If database policy is not represented in Prisma arguments, isolate the key space explicitly:

```ts
await prisma.$attic.withScope(tenantId, () => prisma.user.findMany());
```

The scope is propagated through asynchronous work with `AsyncLocalStorage`; raw values are hashed before entering Redis keys.

### Cached raw reads

Ordinary `$queryRaw` calls bypass caching. Use the parameterized tagged-template helper and declare every model dependency:

```ts
const rows = await prisma.$attic.queryRaw<Array<{ id: number; total: bigint }>>({
  tags: [atticManifest.models.User.tag, atticManifest.models.Order.tag],
  ttlMs: 60_000,
})`
  SELECT u.id, count(o.id)::bigint AS total
  FROM app_users u
  LEFT JOIN orders o ON o.user_id = u.id
  WHERE u.id = ${userId}
  GROUP BY u.id
`;
```

The cache key is derived from the SQL template and bound values. Unsafe raw-query caching is intentionally not exposed. DML performed with Prisma raw execute methods or another PostgreSQL client is captured by the generated table triggers.

### Manual invalidation

```ts
await prisma.$attic.invalidate({ tags: ["active-users"] });
await prisma.$attic.invalidateAll();
```

Manual invalidations are written to the same PostgreSQL outbox before Redis is updated.

## Failure contract

Redis is never the source of truth:

- Redis read, decode, or cache-fill failures fall back to PostgreSQL.
- PostgreSQL errors remain ordinary Prisma errors.
- Startup and health checks verify the generated SQL ABI plus every expected live trigger and its arguments.
- Startup throws `AtticRecoveryRequiredError` if retained Redis generations are ahead of restored PostgreSQL state; rotate or purge the affected namespace before serving traffic.
- If PostgreSQL commits a mutation but immediate Redis synchronization fails, Attic throws `AtticCommittedSyncError` with `committed === true` and a `requestId`.
- If a model mutation commits without a trigger event, Attic durably attempts a global invalidation and throws `AtticCommittedInstallationError`; stop writes and repair the trigger installation.
- Do not blindly retry a committed mutation. Use an idempotency key or inspect the authoritative row.
- The embedded or dedicated worker keeps retrying the durable invalidation.

Old-generation cache entries are not scanned or deleted synchronously. They become unreachable immediately and expire through TTL.

## Worker

`$attic.start()` validates the installation, reconciles durable generations, and starts an unreferenced embedded worker by default. `$attic.stop()` drains local work and stops it. For a dedicated process or serverless cron, use the exported `createAtticWorker()` API and call `runOnce()` or `start()`.

Defaults are a one-second polling interval, 100-event batch, 30-second lease, and capped exponential retry. Multiple workers are safe because PostgreSQL leases events with `FOR UPDATE SKIP LOCKED`, and Redis generation updates are monotonic.

## NestJS configuration

`AtticModule.forRootAsync()` supports NestJS configuration providers. The module owns Redis only when it creates the client from a URL; externally supplied Prisma and Redis clients remain caller-owned unless `manageLifecycle: true` is set. See the [NestJS guide](docs/nestjs.md) for synchronous and asynchronous registration, injection tokens, and shutdown behavior.

## Configuration

```ts
withAttic({
  redis,
  manifest: atticManifest,
  ttlMs: 300_000,
  negativeTtlMs: 5_000,
  distributedLock: false,
  worker: {
    embedded: true,
    pollIntervalMs: 1_000,
    batchSize: 100,
    leaseMs: 30_000,
    maxBackoffMs: 30_000,
  },
  onEvent(event) {
    // Forward metadata to your logger/metrics system. Values and args are never included.
  },
});
```

The cache namespace comes from the generated manifest and is validated against installed trigger metadata. Configure it in the Prisma `generator attic` block.

An optional token-checked Redis lock can coordinate cold misses between processes. In-process single-flight is always enabled. A custom codec may be supplied; the default versioned codec preserves `Date`, `BigInt`, Prisma `Decimal`, `Uint8Array`, Prisma null sentinels, and `Prisma.skip`.

## Compatibility and limitations

- Prisma 7 and PostgreSQL only.
- Node.js 22.12 or newer; Redis server 7.2 or newer.
- NestJS 10 and 11 are supported by the optional subpath.
- Attic must be applied after extensions that alter query arguments or security context.
- A `$queryRaw` statement that invokes a write-producing database function looks like a read to Prisma. Its trigger event is still repaired asynchronously, but use `$executeRaw` or explicit invalidation when synchronous error reporting matters.
- Applying generated trigger SQL requires the runtime PostgreSQL role to be able to execute the trigger functions and access the Attic tables.

See the copyable [examples and recipes](docs/examples.md), [architecture and consistency](docs/architecture.md), [migration workflow](docs/migrations.md), [operations guide](docs/operations.md), [write-strategy guide](docs/write-strategies.md), [NestJS integration](docs/nestjs.md), [security policy](SECURITY.md), and [contributing](CONTRIBUTING.md).

## License

MIT
