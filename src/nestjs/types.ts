import type { InjectionToken, ModuleMetadata, OptionalFactoryDependency } from "@nestjs/common";
import type { RedisClientOptions } from "redis";

import type { AtticOptions, RedisLike } from "../core/types.js";

/** The minimum Prisma surface required by the NestJS adapter. */
export interface AtticPrismaClient {
  $extends(extension: never): unknown;
  $connect?(): Promise<void>;
  $disconnect?(): Promise<void>;
}

/** The lifecycle surface added to a Prisma client by Attic. */
export interface AtticEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly worker?: unknown;
}

/** A Redis client accepted by the core extension and managed by the adapter. */
export type AtticRedisClient = RedisLike;

export interface AtticExtendedClient {
  readonly $attic: AtticEngine;
}

/**
 * A URL creates a Redis client owned by the module. A client instance remains
 * caller-owned unless `manageLifecycle` is enabled.
 */
export type AtticRedisInput = string | RedisLike;

export type AtticModuleOptions<TPrisma extends AtticPrismaClient = AtticPrismaClient> = Omit<
  AtticOptions<TPrisma>,
  "redis"
> & {
  /** An existing Prisma client. Attic never creates a second connection pool. */
  prisma: TPrisma;
  /** An existing node-redis client or a URL from which the module creates one. */
  redis: AtticRedisInput;
  /** Additional node-redis options, used only when `redis` is a URL. */
  redisOptions?: Omit<RedisClientOptions, "url">;
  /**
   * Also connect and close caller-owned Prisma and Redis clients. Disabled by
   * default so that shared application resources retain their original owner.
   */
  manageLifecycle?: boolean;
  /** Register this module globally. Defaults to `false`. */
  global?: boolean;
};

export interface AtticModuleAsyncOptions<
  TPrisma extends AtticPrismaClient = AtticPrismaClient,
  TDependencies extends readonly unknown[] = readonly unknown[],
> extends Pick<ModuleMetadata, "imports"> {
  inject?: readonly (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (...dependencies: TDependencies) => AtticModuleOptions<TPrisma> | Promise<AtticModuleOptions<TPrisma>>;
  /** Register this module globally. Defaults to `false`. */
  global?: boolean;
}

export type AtticNestClient<TPrisma extends AtticPrismaClient = AtticPrismaClient> = ReturnType<TPrisma["$extends"]> &
  AtticExtendedClient;

/** @internal */
export interface AtticRedisResource {
  readonly client: RedisLike;
  readonly owned: boolean;
}
