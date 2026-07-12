# Examples and recipes

This guide starts with the smallest useful setup and then adds one Attic feature at a time. Attic keeps PostgreSQL authoritative. Redis stores disposable query results and tag generations; it never becomes the primary store for Prisma mutations.

## Mental model

```text
Read:  application -> Redis query cache -> PostgreSQL on miss -> Redis fill
Write: application -> PostgreSQL + trigger/outbox commit -> Redis generation advance
Repair: PostgreSQL outbox -> Attic worker -> Redis generation advance
```

Advancing a generation makes older cache entries unreachable immediately. Their TTL removes them later, so Attic never scans Redis for query keys.

## Guide map

- [Generate the manifest and extend one Prisma client](#1-generate-the-manifest-and-extend-one-prisma-client)
- [Use Prisma normally](#2-use-prisma-normally)
- [Tune or bypass one query](#3-tune-or-bypass-one-query)
- [Cache relation-dependent queries](#4-cache-relation-dependent-queries)
- [Isolate tenants and RLS contexts](#5-isolate-tenants-and-rls-contexts)
- [Use interactive transactions](#6-use-interactive-transactions)
- [Cache a parameterized raw read](#7-cache-a-parameterized-raw-read)
- [Handle committed failures](#8-handle-a-committed-synchronization-failure)
- [Run a dedicated worker](#9-run-a-dedicated-worker)
- [Integrate with NestJS](#10-integrate-with-nestjs)
- [Emit metrics](#11-emit-metrics-without-coupling-to-a-logger)
- [Keep Redis-native state separate](#12-keep-redis-native-domain-state-separate)

## 1. Generate the manifest and extend one Prisma client

This walkthrough starts with a Prisma 7 PostgreSQL application. Install the complete set of packages when starting fresh; existing applications need only their missing dependencies:

```sh
pnpm add prisma-extension-attic redis @prisma/client @prisma/adapter-pg dotenv
pnpm add --save-dev prisma
```

Configure the Prisma CLI datasource in the project-root `prisma.config.ts`:

```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
```

Add Attic beside Prisma's client generator in `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

generator attic {
  provider  = "attic-generator"
  output    = "../src/generated/attic"
  namespace = "my-api"
}

datasource db {
  provider = "postgresql"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
}
```

Run Prisma generation after adding or changing the schema:

```sh
pnpm prisma generate
```

The configured outputs now contain this abbreviated tree:

```text
src/generated/
├── prisma/
│   ├── client.ts
│   ├── models.ts
│   └── … other Prisma-generated modules
└── attic/
    ├── manifest.ts
    └── migration.sql
```

`manifest.ts` is generated code. It exports the schema-specific, Prisma-client-typed constant used below; do not hand-author or copy it between schemas. The generator emits the complete object and ends the module with an export like this excerpt:

```ts
import type { PrismaClient } from "../prisma/client.js";
import type { AtticManifest } from "prisma-extension-attic";

const data = {
  // Fully generated namespace, ABI, checksum, model, relation, join-table, and trigger metadata.
} as const;
export const atticManifest: typeof data & AtticManifest<PrismaClient> = data;
```

In TypeScript ESM, import generated `.ts` modules using `.js` specifiers:

```ts
import { PrismaClient } from "./generated/prisma/client.js";
import { atticManifest } from "./generated/attic/manifest.js";
```

TypeScript resolves these to the generated source files and emits valid JavaScript module paths. If you configure another Attic `output`, import from that location; the generated export remains named `atticManifest`. `withAttic` consumes it to bind cache dependency tracking and startup validation to the exact Prisma schema and PostgreSQL trigger installation.

Create and apply the initial migration through Attic's wrapper. It runs every configured generator, injects the generated trigger SQL into the Prisma migration, and then applies it:

```sh
pnpm exec attic migrate dev --name install_attic
```

Prisma 7 requires an application-owned driver adapter. Attic extends that client and does not create another PostgreSQL pool.

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { createClient } from "redis";

import { withAttic } from "prisma-extension-attic";
import { PrismaClient } from "./generated/prisma/client.js";
import { atticManifest } from "./generated/attic/manifest.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const basePrisma = new PrismaClient({ adapter });

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (error) => console.error("Redis error", error));
await redis.connect();

export const prisma = basePrisma.$extends(
  withAttic({
    redis,
    manifest: atticManifest,
  }),
);

await prisma.$attic.start();
```

Stop Attic before closing resources owned by the application:

```ts
await prisma.$attic.stop();
await redis.close();
await basePrisma.$disconnect();
```

`$attic.start()` is idempotent. It validates the database installation, reconciles durable tag generations, and starts the embedded worker unless configured otherwise.

Treat startup validation failures as deployment blockers:

```ts
import { AtticInstallationError, AtticRecoveryRequiredError, AtticSchemaMismatchError } from "prisma-extension-attic";

try {
  await prisma.$attic.start();
} catch (error) {
  if (error instanceof AtticSchemaMismatchError) {
    // Generate and apply the missing/stale Attic migration.
  } else if (error instanceof AtticInstallationError) {
    // A required SQL ABI or live trigger does not match the manifest.
  } else if (error instanceof AtticRecoveryRequiredError) {
    // Redis is newer than restored PostgreSQL. Rotate or fully purge the namespace.
  }
  throw error;
}
```

## 2. Use Prisma normally

The supported read operations cache automatically. No cache API is added to the result and no return type is widened.

```ts
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: {
    id: true,
    email: true,
    profile: { select: { displayName: true } },
  },
});
```

The first call checks Redis and queries PostgreSQL on a miss. Equivalent later calls reuse the cached result. The full arguments, model, operation, scope, and current dependency generations are hashed into the key.

Attic caches these operations:

- `findUnique` and `findUniqueOrThrow`
- `findFirst` and `findFirstOrThrow`
- `findMany`
- `count`, `aggregate`, and `groupBy`

Writes keep their normal Prisma syntax:

```ts
await prisma.user.update({
  where: { id: userId },
  data: { displayName: "Ada" },
});
```

After PostgreSQL commits, Attic advances the affected Redis generations. The next dependent read misses and reloads authoritative data.

## 3. Tune or bypass one query

Use the default policy for most reads. Override it only where the data's useful lifetime is meaningfully different.

```ts
const activeUsers = await prisma.user.findMany({
  where: { active: true },
  cacheStrategy: {
    ttlMs: 30_000,
    tags: ["active-users"],
  },
});
```

Bypass caching for a volatile or high-cardinality query:

```ts
const liveResult = await prisma.user.findMany({
  where: { updatedAt: { gte: new Date(Date.now() - 1_000) } },
  cacheStrategy: false,
});
```

Manual tags supplement automatic model dependencies. Arbitrary manual tags must be advanced explicitly when their non-model dependency changes:

```ts
await prisma.$attic.invalidate({ tags: ["active-users"] });
```

## 4. Cache relation-dependent queries

Attic reads relation metadata from the generated manifest. Relation fields referenced by filters, selections, includes, omission, or ordering add their model tags automatically.

```ts
const authors = await prisma.user.findMany({
  where: {
    posts: {
      some: { published: true },
    },
  },
  include: {
    posts: {
      where: { published: true },
      orderBy: { publishedAt: "desc" },
    },
  },
});
```

A relevant `User`, `Post`, or implicit many-to-many join-table write makes this cached result unreachable. You do not need to enumerate those model tags yourself.

Prisma's fluent relation API remains available on cached single-record reads:

```ts
const posts = await prisma.user
  .findUnique({
    where: { id: userId },
    cacheStrategy: { ttlMs: 30_000 },
  })
  .posts({
    where: { published: true },
    select: { id: true, title: true },
  });
// Array<{ id: number; title: string }> | null
```

## 5. Isolate tenants and RLS contexts

If authorization or tenant state is already represented in Prisma arguments, it naturally participates in the cache key. When database policy depends on connection or request context not visible in the query arguments, add an explicit scope.

```ts
const users = await prisma.$attic.withScope(tenantId, () => {
  return prisma.user.findMany({ where: { active: true } });
});
```

Scopes flow through asynchronous work using `AsyncLocalStorage` and are hashed before entering Redis keys. Apply Attic after extensions that add tenant or authorization filters.

Never run a policy-dependent read outside its required scope merely to improve cache reuse.

## 6. Use interactive transactions

Use `$attic.transaction()` rather than the extended client's ordinary `$transaction()`:

```ts
const account = await prisma.$attic.transaction(
  async (tx) => {
    const created = await tx.account.create({
      data: { ownerId: userId, balance: 0 },
    });

    await tx.auditLog.create({
      data: { accountId: created.id, action: "created" },
    });

    return created;
  },
  { isolationLevel: "Serializable" },
);
```

The transaction client bypasses cache reads, preserving snapshots and read-your-writes behavior. Trigger events synchronize only after commit. A rollback creates no durable invalidation.

Batch-array transactions are unsupported in v0.1 because Prisma's public extension API does not expose sufficient transaction context to preserve Attic's guarantees.

## 7. Cache a parameterized raw read

Normal `$queryRaw` calls bypass caching. For an expensive read, declare every model dependency and use the tagged-template helper:

```ts
const totals = await prisma.$attic.queryRaw<Array<{ userId: number; orderCount: bigint; total: bigint }>>({
  tags: [atticManifest.models.User.tag, atticManifest.models.Order.tag],
  ttlMs: 60_000,
})`
  SELECT u.id AS "userId",
         count(o.id)::bigint AS "orderCount",
         coalesce(sum(o.total), 0)::bigint AS total
    FROM app_users AS u
    LEFT JOIN orders AS o ON o.user_id = u.id
   WHERE u.id = ${userId}
   GROUP BY u.id
`;
```

The SQL template and bound values participate in the hashed key. An empty tag list is rejected because Attic cannot safely infer dependencies from arbitrary SQL.

Use `$executeRaw` for raw DML when synchronous post-commit error reporting matters. Table triggers still capture external SQL and write-producing database functions, but writes hidden behind `$queryRaw` reconcile asynchronously.

## 8. Handle a committed synchronization failure

A Redis failure after PostgreSQL commits cannot roll the database transaction back. Attic makes this state explicit:

```ts
import { AtticCommittedInstallationError, AtticCommittedSyncError } from "prisma-extension-attic";

try {
  await prisma.invoice.create({
    data: { customerId, total, idempotencyKey },
  });
} catch (error) {
  if (error instanceof AtticCommittedInstallationError) {
    // The mutation committed, but its expected table trigger did not emit an event.
    // Attic attempted a durable global fallback invalidation. Stop writes and repair
    // the installation before continuing.
    console.error("Attic trigger installation is invalid", { requestId: error.requestId });
    throw error;
  } else if (error instanceof AtticCommittedSyncError) {
    console.error("Database write committed; cache repair is pending", {
      requestId: error.requestId,
    });

    // Do not blindly repeat a non-idempotent mutation.
    const invoice = await basePrisma.invoice.findUnique({
      where: { idempotencyKey },
    });
    // Return or reconcile from PostgreSQL according to the application contract.
  } else {
    throw error;
  }
}
```

The durable event remains in PostgreSQL for the worker. Redis read failures are different: ordinary cached reads simply fall back to PostgreSQL.

## 9. Run a dedicated worker

The embedded worker is convenient for a long-running application. Disable it when invalidations should be processed by a dedicated process or a serverless cron.

Application client:

```ts
const prisma = basePrisma.$extends(
  withAttic({
    redis,
    manifest: atticManifest,
    worker: false,
  }),
);
```

Dedicated worker process:

```ts
import { createAtticWorker } from "prisma-extension-attic";

const worker = createAtticWorker({
  prisma: basePrisma,
  redis,
  manifest: atticManifest,
});

await worker.start();

process.once("SIGTERM", () => {
  void worker.stop();
});
```

Serverless or scheduled execution:

```ts
export async function reconcileAttic(): Promise<void> {
  const worker = createAtticWorker({
    prisma: basePrisma,
    redis,
    manifest: atticManifest,
  });

  try {
    await worker.runOnce();
  } finally {
    await worker.stop();
  }
}
```

Multiple workers are safe because event leases use `FOR UPDATE SKIP LOCKED` and Redis generation changes are monotonic.

## 10. Integrate with NestJS

Register an existing Prisma client and either a Redis URL or an existing node-redis client:

```ts
import { Module } from "@nestjs/common";
import { AtticModule } from "prisma-extension-attic/nestjs";

@Module({
  imports: [
    AtticModule.forRoot({
      prisma: basePrisma,
      redis: process.env.REDIS_URL!,
      manifest: atticManifest,
    }),
  ],
  exports: [AtticModule],
})
export class DatabaseModule {}
```

Inject the typed client:

```ts
import { Injectable } from "@nestjs/common";
import { InjectAtticClient, type AtticNestClient } from "prisma-extension-attic/nestjs";

@Injectable()
export class UsersService {
  public constructor(
    @InjectAtticClient()
    private readonly prisma: AtticNestClient<typeof basePrisma>,
  ) {}

  public findById(id: number) {
    return this.prisma.user.findUnique({ where: { id } });
  }
}
```

When given a URL, the module owns the Redis client it creates. Supplied Prisma and Redis clients remain application-owned unless `manageLifecycle: true` is explicitly enabled.

See the dedicated [NestJS guide](nestjs.md) for asynchronous registration and lifecycle details.

## 11. Emit metrics without coupling to a logger

Use `onEvent` to connect Attic to the application's existing telemetry stack:

```ts
const prisma = basePrisma.$extends(
  withAttic({
    redis,
    manifest: atticManifest,
    onEvent(event) {
      switch (event.type) {
        case "cache.hit":
        case "cache.miss":
          metrics.increment(`attic.${event.type}`, {
            model: event.model ?? "raw",
            operation: event.operation ?? "unknown",
          });
          break;
        case "worker.error":
        case "write.error":
          logger.error({ event }, "Attic operation failed");
          break;
      }
    },
  }),
);
```

Do not attach raw query arguments or cached values to metrics. Attic events intentionally contain metadata only.

## 12. Keep Redis-native domain state separate

Attic is appropriate when a result is derived from PostgreSQL and can be discarded from Redis. It is not a replacement for Redis-native application state such as:

- rate limits and idempotency claims;
- online presence and short-lived locations;
- counters, streams, queues, sorted sets, and geo indexes;
- domain-specific write aggregation or write-behind persistence.

Use a separate, explicit Redis service for those workloads. This keeps normal Prisma semantics predictable and makes the different durability contract visible at call sites.

## Common mistakes

| Mistake                                                  | Correct approach                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| Calling plain `prisma migrate dev` after a schema change | Point the project migration script to `attic migrate dev`            |
| Retrying every `AtticCommittedSyncError`                 | Inspect PostgreSQL or use an application idempotency key             |
| Caching RLS-dependent reads without a scope              | Wrap the operation in `$attic.withScope()`                           |
| Caching arbitrary SQL without complete tags              | Declare every model dependency or bypass caching                     |
| Expecting writes to update every cached query shape      | Attic invalidates generations; the next read refills from PostgreSQL |
| Using Attic as a Redis-first write buffer                | Use a separate explicit command/stream subsystem                     |
| Managing a caller-owned Redis client from two modules    | Leave `manageLifecycle` disabled and keep one clear resource owner   |

For deployment thresholds, restore handling, backlog monitoring, and outage procedures, see the [operations guide](operations.md).
