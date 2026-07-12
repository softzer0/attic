import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type * as RedisPackage from "redis";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  withAttic: vi.fn((options: unknown) => ({ options })),
}));

vi.mock("redis", async (importOriginal) => ({
  ...(await importOriginal<typeof RedisPackage>()),
  createClient: mocks.createClient,
}));

vi.mock("../../src/extension.js", () => ({
  withAttic: mocks.withAttic,
}));

import {
  ATTIC_CLIENT,
  ATTIC_ENGINE,
  ATTIC_REDIS_CLIENT,
  ATTIC_WORKER,
  AtticModule,
  type AtticModuleOptions,
  type AtticRedisClient,
} from "../../src/nestjs/index.js";

const createRedis = (initiallyOpen = true) => {
  let open = initiallyOpen;
  return {
    get isOpen() {
      return open;
    },
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
    del: vi.fn(() => Promise.resolve(1)),
    eval: vi.fn(() => Promise.resolve(null)),
    on: vi.fn(),
    connect: vi.fn(() => {
      open = true;
      return Promise.resolve();
    }),
    quit: vi.fn(() => {
      open = false;
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      open = false;
      return Promise.resolve();
    }),
  } satisfies AtticRedisClient & { on(): void };
};

const createFixture = (redis: AtticRedisClient) => {
  const engine = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    worker: { run: vi.fn() },
  };
  const client = { $attic: engine };
  const prisma = {
    $extends: vi.fn((extension: never) => {
      void extension;
      return client;
    }),
    $connect: vi.fn(() => Promise.resolve()),
    $disconnect: vi.fn(() => Promise.resolve()),
  };
  const options = {
    manifest: {},
    prisma,
    redis,
  } as unknown as AtticModuleOptions<typeof prisma>;

  return { client, engine, options, prisma };
};

describe("AtticModule", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    mocks.withAttic.mockClear();
  });

  it("starts Attic without taking ownership of supplied clients", async () => {
    const redis = createRedis();
    const fixture = createFixture(redis);
    const definition = AtticModule.forRoot(fixture.options);
    const moduleRef = await Test.createTestingModule({ imports: [definition] }).compile();

    expect(definition.global).toBe(false);
    await moduleRef.init();

    expect(moduleRef.get(ATTIC_CLIENT)).toBe(fixture.client);
    expect(moduleRef.get(ATTIC_ENGINE)).toBe(fixture.engine);
    expect(moduleRef.get(ATTIC_WORKER)).toBe(fixture.engine.worker);
    expect(moduleRef.get(ATTIC_REDIS_CLIENT)).toBe(redis);
    expect(mocks.withAttic).toHaveBeenCalledWith({ manifest: {}, redis });
    expect(fixture.engine.start).toHaveBeenCalledOnce();
    expect(redis.connect).not.toHaveBeenCalled();
    expect(fixture.prisma.$connect).not.toHaveBeenCalled();

    await moduleRef.close();

    expect(fixture.engine.stop).toHaveBeenCalledOnce();
    expect(redis.close).not.toHaveBeenCalled();
    expect(fixture.prisma.$disconnect).not.toHaveBeenCalled();
  });

  it("manages supplied Prisma and Redis clients when explicitly requested", async () => {
    const redis = createRedis(false);
    const fixture = createFixture(redis);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AtticModule.forRoot({
          ...fixture.options,
          manageLifecycle: true,
        }),
      ],
    }).compile();

    await moduleRef.init();
    expect(fixture.prisma.$connect).toHaveBeenCalledOnce();
    expect(redis.connect).toHaveBeenCalledOnce();

    await moduleRef.close();
    expect(redis.close).toHaveBeenCalledOnce();
    expect(fixture.prisma.$disconnect).toHaveBeenCalledOnce();
  });

  it("creates and owns Redis when configured with a URL", async () => {
    const redis = createRedis(false);
    mocks.createClient.mockReturnValue(redis);
    const fixture = createFixture(redis);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AtticModule.forRoot({
          ...fixture.options,
          redis: "redis://localhost:6379",
        }),
      ],
    }).compile();

    await moduleRef.init();
    expect(mocks.createClient).toHaveBeenCalledWith({ url: "redis://localhost:6379" });
    expect(redis.connect).toHaveBeenCalledOnce();
    expect(fixture.prisma.$connect).not.toHaveBeenCalled();

    await moduleRef.close();
    expect(redis.close).toHaveBeenCalledOnce();
  });

  it("resolves asynchronous options and honors the global flag", async () => {
    const redis = createRedis();
    const fixture = createFixture(redis);
    const definition = AtticModule.forRootAsync({
      global: true,
      useFactory: () => Promise.resolve(fixture.options),
    });
    const moduleRef = await Test.createTestingModule({
      imports: [definition],
    }).compile();

    expect(definition.global).toBe(true);
    await moduleRef.init();
    expect(moduleRef.get(ATTIC_CLIENT)).toBe(fixture.client);
    await moduleRef.close();
  });
});
