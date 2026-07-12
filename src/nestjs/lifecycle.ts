import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { ATTIC_CLIENT, ATTIC_MODULE_OPTIONS, ATTIC_REDIS_RESOURCE } from "./tokens.js";
import type { AtticExtendedClient, AtticModuleOptions, AtticRedisResource } from "./types.js";

@Injectable()
export class AtticLifecycle implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  readonly #options: AtticModuleOptions;
  readonly #client: AtticExtendedClient;
  readonly #redis: AtticRedisResource;
  #started = false;
  #stopped = false;

  public constructor(
    @Inject(ATTIC_MODULE_OPTIONS) options: AtticModuleOptions,
    @Inject(ATTIC_CLIENT) client: AtticExtendedClient,
    @Inject(ATTIC_REDIS_RESOURCE) redis: AtticRedisResource,
  ) {
    this.#options = options;
    this.#client = client;
    this.#redis = redis;
  }

  public async onModuleInit(): Promise<void> {
    const manageExternal = this.#options.manageLifecycle === true;

    try {
      if (manageExternal) {
        await this.#options.prisma.$connect?.();
      }

      if ((this.#redis.owned || manageExternal) && this.#redis.client.isOpen !== true) {
        if (this.#redis.client.connect === undefined) {
          throw new TypeError("The configured Redis client does not expose connect().");
        }
        await this.#redis.client.connect();
      }

      await this.#client.$attic.start();
      this.#started = true;
    } catch (error) {
      try {
        await this.#releaseManagedResources();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Attic startup and resource cleanup failed");
      }
      throw error;
    }
  }

  public async onModuleDestroy(): Promise<void> {
    await this.#shutdown();
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.#shutdown();
  }

  async #shutdown(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;

    const failures: unknown[] = [];
    if (this.#started) {
      try {
        await this.#client.$attic.stop();
      } catch (error) {
        failures.push(error);
      }
    }

    try {
      await this.#releaseManagedResources();
    } catch (error) {
      failures.push(error);
    }

    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to stop Attic cleanly");
    }
  }

  async #releaseManagedResources(): Promise<void> {
    const manageExternal = this.#options.manageLifecycle === true;
    const failures: unknown[] = [];

    if (this.#redis.owned || manageExternal) {
      try {
        if (this.#redis.client.isOpen !== false) {
          if (this.#redis.client.close !== undefined) {
            await this.#redis.client.close();
          } else if (this.#redis.client.quit !== undefined) {
            await this.#redis.client.quit();
          } else if (this.#redis.client.destroy !== undefined) {
            this.#redis.client.destroy();
          } else {
            this.#redis.client.disconnect?.();
          }
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (manageExternal) {
      try {
        await this.#options.prisma.$disconnect?.();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to release Attic resources");
    }
  }
}
