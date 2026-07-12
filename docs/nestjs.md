# NestJS integration

Import `AtticModule` from the optional `prisma-extension-attic/nestjs` entry point. The core package remains framework-neutral.

The examples use `basePrisma` for your existing Prisma 7 client and `atticManifest` for the generated file described in the README setup. Attic creates neither value inside the module.

## Synchronous registration

```ts
import { Module } from "@nestjs/common";
import { AtticModule } from "prisma-extension-attic/nestjs";
import { atticManifest } from "./generated/attic/manifest.js";

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

`forRoot()` is non-global unless `global: true` is explicit. It extends the supplied Prisma client; it does not create a second PostgreSQL pool.

## Asynchronous registration

Asynchronous registration uses the same generated `atticManifest` import shown above:

```ts
AtticModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  async useFactory(config: ConfigService) {
    return {
      prisma: basePrisma,
      redis: config.getOrThrow<string>("REDIS_URL"),
      manifest: atticManifest,
      worker: { embedded: true },
    };
  },
});
```

Inject the extended client with `@InjectAtticClient()` or the `ATTIC_CLIENT` token. Infrastructure providers can inject the `$attic` control plane with `@InjectAtticEngine()` and the worker with `@InjectAtticWorker()`; their equivalent tokens are `ATTIC_ENGINE` and `ATTIC_WORKER`. `ATTIC_REDIS_CLIENT` exposes the module's Redis client when direct health integration is required. Use `AtticNestClient<typeof basePrisma>` when a named client type is useful.

## Resource ownership

- A Redis URL makes the module create, connect, and close its own node-redis client.
- A supplied Redis client and the supplied Prisma client remain caller-owned by default.
- Set `manageLifecycle: true` only when this module should also connect and close those external clients.
- Module initialization calls `$attic.start()`, so stale migration metadata fails application startup.
- Shutdown stops the embedded worker before releasing resources owned by the module.

Internally created Redis clients forward connection errors to the framework-neutral `onEvent` hook. No logger implementation is required.
