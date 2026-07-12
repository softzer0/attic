import type { DynamicModule, FactoryProvider, Provider } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { createClient } from "redis";

import { withAttic } from "../extension.js";
import { AtticLifecycle } from "./lifecycle.js";
import {
  ATTIC_CLIENT,
  ATTIC_ENGINE,
  ATTIC_MODULE_OPTIONS,
  ATTIC_REDIS_CLIENT,
  ATTIC_REDIS_RESOURCE,
  ATTIC_WORKER,
} from "./tokens.js";
import type {
  AtticEngine,
  AtticExtendedClient,
  AtticModuleAsyncOptions,
  AtticModuleOptions,
  AtticPrismaClient,
  AtticRedisResource,
} from "./types.js";

const createRedisResource = (options: AtticModuleOptions): AtticRedisResource => {
  if (typeof options.redis !== "string") {
    return {
      client: options.redis,
      owned: false,
    } as AtticRedisResource;
  }

  const client = createClient({
    ...options.redisOptions,
    url: options.redis,
  });
  client.on("error", (error) => options.onEvent?.({ type: "redis.error", error }));

  return {
    client: client as AtticRedisResource["client"],
    owned: true,
  };
};

const extensionOptionsFrom = (options: AtticModuleOptions) => {
  const { global, manageLifecycle, prisma, redis, redisOptions, ...extensionOptions } = options;
  void global;
  void manageLifecycle;
  void prisma;
  void redis;
  void redisOptions;
  return extensionOptions;
};

const sharedProviders = (): Provider[] => [
  {
    provide: ATTIC_REDIS_RESOURCE,
    inject: [ATTIC_MODULE_OPTIONS],
    useFactory: createRedisResource,
  },
  {
    provide: ATTIC_REDIS_CLIENT,
    inject: [ATTIC_REDIS_RESOURCE],
    useFactory: (resource: AtticRedisResource) => resource.client,
  },
  {
    provide: ATTIC_CLIENT,
    inject: [ATTIC_MODULE_OPTIONS, ATTIC_REDIS_RESOURCE],
    useFactory: (options: AtticModuleOptions, redis: AtticRedisResource) => {
      return options.prisma.$extends(
        withAttic({
          ...extensionOptionsFrom(options),
          redis: redis.client,
        }) as never,
      ) as AtticExtendedClient;
    },
  },
  {
    provide: ATTIC_ENGINE,
    inject: [ATTIC_CLIENT],
    useFactory: (client: AtticExtendedClient): AtticEngine => client.$attic,
  },
  {
    provide: ATTIC_WORKER,
    inject: [ATTIC_ENGINE],
    useFactory: (engine: AtticEngine): unknown => engine.worker ?? null,
  },
  AtticLifecycle,
];

const moduleDefinition = (
  optionsProvider: Provider,
  global: boolean,
  imports: DynamicModule["imports"] = [],
): DynamicModule => ({
  module: AtticModule,
  global,
  imports,
  providers: [optionsProvider, ...sharedProviders()],
  exports: [ATTIC_CLIENT, ATTIC_ENGINE, ATTIC_WORKER, ATTIC_REDIS_CLIENT],
});

@Module({})
// Nest discovers dynamic modules through this conventional static class API.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AtticModule {
  public static forRoot<TPrisma extends AtticPrismaClient>(options: AtticModuleOptions<TPrisma>): DynamicModule {
    return moduleDefinition(
      {
        provide: ATTIC_MODULE_OPTIONS,
        useValue: options,
      },
      options.global ?? false,
    );
  }

  public static forRootAsync<
    TPrisma extends AtticPrismaClient,
    TDependencies extends readonly unknown[] = readonly unknown[],
  >(options: AtticModuleAsyncOptions<TPrisma, TDependencies>): DynamicModule {
    const optionsProvider: FactoryProvider = {
      provide: ATTIC_MODULE_OPTIONS,
      inject: options.inject === undefined ? [] : [...options.inject],
      useFactory: options.useFactory,
    } as FactoryProvider;

    return moduleDefinition(optionsProvider, options.global ?? false, options.imports);
  }
}
