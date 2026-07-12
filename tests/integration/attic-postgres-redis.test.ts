import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AtticEvent, AtticManifest, RedisEvalOptions, RedisLike, RedisSetOptions } from "../../src/core/types.js";
import { AtticCommittedSyncError } from "../../src/core/errors.js";
import { withAttic } from "../../src/extension.js";
import { renderMigrationSql } from "../../src/generator/migration.js";
import { triggerName } from "../../src/generator/sql-escaping.js";
import { Prisma, PrismaClient } from "../fixtures/generated/client.js";

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const servicesAvailable = databaseUrl !== undefined && redisUrl !== undefined;

type RedisClient = ReturnType<typeof createClient>;

class TrackingRedis implements RedisLike {
  public failReads = false;
  public failEvaluations = false;
  public readonly touchedKeys = new Set<string>();

  public constructor(private readonly client: RedisClient) {}

  public get isOpen(): boolean {
    return this.client.isOpen;
  }

  public get isReady(): boolean {
    return this.client.isReady;
  }

  public async get(key: string): Promise<string | null> {
    if (this.failReads) throw new Error("Simulated Redis read outage");
    return this.client.get(key);
  }

  public async set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    this.touchedKeys.add(key);
    return this.client.set(key, value, options);
  }

  public async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  public async eval(script: string, options?: RedisEvalOptions): Promise<unknown> {
    if (this.failEvaluations) throw new Error("Simulated Redis generation write outage");
    for (const key of options?.keys ?? []) this.touchedKeys.add(key);
    return this.client.eval(script, options);
  }

  public async deleteTouchedKeys(): Promise<void> {
    await Promise.all([...this.touchedKeys].map((key) => this.client.del(key)));
    this.touchedKeys.clear();
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function manifestFor(schema: string, namespace: string): AtticManifest<PrismaClient> {
  const tag = (model: string): string => `model:${model}`;
  const relation = (field: string, model: string, isList: boolean) => ({
    field,
    model,
    isList,
    dependencies: [tag(model)],
  });

  return {
    version: 1,
    sqlAbiVersion: 1,
    namespace,
    schemaChecksum: "f".repeat(64),
    models: {
      User: {
        name: "User",
        dbName: "app_users",
        schema,
        tag: tag("User"),
        relations: {
          posts: relation("posts", "Post", true),
          profile: relation("profile", "Profile", false),
          tags: relation("tags", "Tag", true),
        },
      },
      Profile: {
        name: "Profile",
        dbName: "user_profiles",
        schema,
        tag: tag("Profile"),
        relations: { user: relation("user", "User", false) },
      },
      Post: {
        name: "Post",
        dbName: "Post",
        schema,
        tag: tag("Post"),
        relations: {
          author: relation("author", "User", false),
          tags: relation("tags", "Tag", true),
        },
      },
      Tag: {
        name: "Tag",
        dbName: "Tag",
        schema,
        tag: tag("Tag"),
        relations: {
          posts: relation("posts", "Post", true),
          users: relation("users", "User", true),
        },
      },
    },
    implicitJoinTables: [
      {
        name: "_PostToTag",
        schema,
        relationName: "PostToTag",
        models: ["Post", "Tag"],
        tags: [tag("Post"), tag("Tag")],
      },
      {
        name: "_TagToUser",
        schema,
        relationName: "TagToUser",
        models: ["Tag", "User"],
        tags: [tag("Tag"), tag("User")],
      },
    ],
    triggers: [
      { name: triggerName(schema, "app_users", namespace), schema, table: "app_users", tags: [tag("User")] },
      {
        name: triggerName(schema, "user_profiles", namespace),
        schema,
        table: "user_profiles",
        tags: [tag("Profile")],
      },
      { name: triggerName(schema, "Post", namespace), schema, table: "Post", tags: [tag("Post")] },
      { name: triggerName(schema, "Tag", namespace), schema, table: "Tag", tags: [tag("Tag")] },
      {
        name: triggerName(schema, "_PostToTag", namespace),
        schema,
        table: "_PostToTag",
        tags: [tag("Post"), tag("Tag")],
      },
      {
        name: triggerName(schema, "_TagToUser", namespace),
        schema,
        table: "_TagToUser",
        tags: [tag("Tag"), tag("User")],
      },
    ],
  };
}

function applicationSchemaSql(schema: string): string {
  const qualified = (table: string): string => `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  return `
CREATE SCHEMA ${quoteIdentifier(schema)};

CREATE TABLE ${qualified("app_users")} (
  "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "email" text NOT NULL UNIQUE,
  "name" text
);

CREATE TABLE ${qualified("user_profiles")} (
  "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "bio" text,
  "userId" integer NOT NULL UNIQUE REFERENCES ${qualified("app_users")} ("id") ON DELETE CASCADE
);

CREATE TABLE ${qualified("Post")} (
  "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "title" text NOT NULL,
  "published" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "authorId" integer NOT NULL REFERENCES ${qualified("app_users")} ("id") ON DELETE CASCADE
);

CREATE TABLE ${qualified("Tag")} (
  "id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  "name" text NOT NULL UNIQUE
);

CREATE TABLE ${qualified("_PostToTag")} (
  "A" integer NOT NULL REFERENCES ${qualified("Post")} ("id") ON DELETE CASCADE,
  "B" integer NOT NULL REFERENCES ${qualified("Tag")} ("id") ON DELETE CASCADE,
  CONSTRAINT "_PostToTag_AB_unique" UNIQUE ("A", "B")
);

CREATE TABLE ${qualified("_TagToUser")} (
  "A" integer NOT NULL REFERENCES ${qualified("Tag")} ("id") ON DELETE CASCADE,
  "B" integer NOT NULL REFERENCES ${qualified("app_users")} ("id") ON DELETE CASCADE,
  CONSTRAINT "_TagToUser_AB_unique" UNIQUE ("A", "B")
);
`;
}

function extendClient(
  client: PrismaClient,
  manifest: AtticManifest<PrismaClient>,
  redis: RedisLike,
  onEvent: (event: AtticEvent) => void,
) {
  return client.$extends(
    withAttic({
      manifest,
      redis,
      worker: { embedded: false },
      onEvent,
    }),
  );
}

type ExtendedClient = ReturnType<typeof extendClient>;

describe.skipIf(!servicesAvailable).sequential("Attic with PostgreSQL and Redis", () => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 20);
  const schema = `attic_it_${runId}`;
  const namespace = `attic-it-${runId}`;
  const manifest = manifestFor(schema, namespace);
  const events: AtticEvent[] = [];

  let pool: Pool | undefined;
  let redisClient: RedisClient | undefined;
  let redis: TrackingRedis | undefined;
  let prisma: PrismaClient | undefined;
  let attic: ExtendedClient | undefined;

  beforeAll(async () => {
    if (databaseUrl === undefined || redisUrl === undefined) return;

    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    await pool.query(applicationSchemaSql(schema));
    await pool.query(renderMigrationSql(manifest));

    redisClient = createClient({ url: redisUrl, disableOfflineQueue: true });
    redisClient.on("error", () => undefined);
    await redisClient.connect();
    redis = new TrackingRedis(redisClient);

    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }) });
    attic = extendClient(prisma, manifest, redis, (event) => events.push(event));
    await attic.$attic.start();
  });

  afterAll(async () => {
    await attic?.$attic.stop();
    await prisma?.$disconnect();
    await redis?.deleteTouchedKeys();
    if (redisClient?.isOpen === true) await redisClient.quit();

    if (pool !== undefined) {
      await pool.query("DELETE FROM attic.outbox WHERE namespace = $1", [namespace]);
      await pool.query("DELETE FROM attic.tag_state WHERE namespace = $1", [namespace]);
      await pool.query("DELETE FROM attic.installation WHERE namespace = $1", [namespace]);
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      await pool.end();
    }
  });

  it("uses Redis cache-aside and invalidates mapped-table reads after Prisma writes", async () => {
    if (attic === undefined) throw new Error("Integration client was not initialized.");

    const user = await attic.user.create({
      data: { email: `${runId}-mapped@example.test`, name: "before" },
    });
    events.length = 0;

    await expect(attic.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({ name: "before" });
    await expect(attic.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({ name: "before" });
    expect(events.filter((event) => event.type === "cache.miss")).toHaveLength(1);
    expect(events.filter((event) => event.type === "cache.hit")).toHaveLength(1);

    await attic.user.update({ where: { id: user.id }, data: { name: "after" } });
    events.length = 0;

    await expect(attic.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({ name: "after" });
    expect(events.some((event) => event.type === "cache.miss")).toBe(true);
  });

  it("repairs external writes from the durable outbox", async () => {
    if (attic === undefined || pool === undefined) throw new Error("Integration client was not initialized.");

    const user = await attic.user.create({
      data: { email: `${runId}-external@example.test`, name: "cached" },
    });
    await attic.user.findUnique({ where: { id: user.id } });
    await attic.user.findUnique({ where: { id: user.id } });

    await pool.query(
      `UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier("app_users")} SET "name" = $1 WHERE "id" = $2`,
      ["external", user.id],
    );
    await expect(attic.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({ name: "cached" });

    const repaired = await attic.$attic.worker.runOnce();
    expect(repaired).toBeGreaterThan(0);
    await expect(attic.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({ name: "external" });
  });

  it("synchronizes committed interactive transactions and preserves rollbacks", async () => {
    if (attic === undefined) throw new Error("Integration client was not initialized.");

    const committedEmail = `${runId}-committed@example.test`;
    const rolledBackEmail = `${runId}-rolled-back@example.test`;
    await attic.$attic.transaction(async (transaction) =>
      transaction.user.create({ data: { email: committedEmail, name: "committed" } }),
    );

    await expect(attic.user.findUnique({ where: { email: committedEmail } })).resolves.toMatchObject({
      name: "committed",
    });

    await expect(
      attic.$attic.transaction(async (transaction) => {
        await transaction.user.create({ data: { email: rolledBackEmail, name: "rolled back" } });
        throw new Error("rollback requested");
      }),
    ).rejects.toThrow("rollback requested");

    await expect(
      attic.user.findUnique({ where: { email: rolledBackEmail }, cacheStrategy: false }),
    ).resolves.toBeNull();
  });

  it("falls back to PostgreSQL during a Redis read outage", async () => {
    if (attic === undefined || redis === undefined) throw new Error("Integration client was not initialized.");

    const user = await attic.user.create({
      data: { email: `${runId}-outage@example.test`, name: "database" },
    });
    redis.failReads = true;
    try {
      await expect(attic.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({ name: "database" });
    } finally {
      redis.failReads = false;
    }
  });

  it("reports a committed write outage and lets the worker repair it", async () => {
    if (attic === undefined || redis === undefined) throw new Error("Integration client was not initialized.");

    const user = await attic.user.create({
      data: { email: `${runId}-committed-outage@example.test`, name: "before" },
    });
    await attic.user.findUnique({ where: { id: user.id } });

    redis.failEvaluations = true;
    let syncError: unknown;
    try {
      await attic.user.update({ where: { id: user.id }, data: { name: "committed" } });
    } catch (error) {
      syncError = error;
    } finally {
      redis.failEvaluations = false;
    }
    expect(syncError).toBeInstanceOf(AtticCommittedSyncError);
    expect(syncError).toEqual(expect.objectContaining({ committed: true }));

    await expect(attic.user.findUnique({ where: { id: user.id }, cacheStrategy: false })).resolves.toMatchObject({
      name: "committed",
    });
    await expect(attic.$attic.worker.runOnce()).resolves.toBeGreaterThan(0);
    await expect(attic.user.findUnique({ where: { id: user.id } })).resolves.toMatchObject({ name: "committed" });
  });

  it("invalidates nested writes, implicit joins, and cascaded relations", async () => {
    if (attic === undefined) throw new Error("Integration client was not initialized.");

    const tag = await attic.tag.create({ data: { name: `${runId}-nested-tag` } });
    const user = await attic.user.create({
      data: {
        email: `${runId}-nested@example.test`,
        profile: { create: { bio: "before" } },
        posts: { create: { title: "nested post" } },
      },
      include: { posts: true },
    });

    await attic.user.findUnique({ where: { id: user.id }, include: { profile: true, posts: true, tags: true } });
    await attic.user.findUnique({ where: { id: user.id }, include: { profile: true, posts: true, tags: true } });

    await attic.user.update({
      where: { id: user.id },
      data: {
        profile: { update: { bio: "after" } },
        tags: { connect: { id: tag.id } },
      },
    });

    await expect(
      attic.user.findUnique({ where: { id: user.id }, include: { profile: true, tags: true } }),
    ).resolves.toMatchObject({
      profile: { bio: "after" },
      tags: [{ id: tag.id }],
    });

    await expect(attic.post.count({ where: { authorId: user.id } })).resolves.toBe(1);
    await expect(attic.profile.count({ where: { userId: user.id } })).resolves.toBe(1);
    await attic.user.delete({ where: { id: user.id } });
    await expect(attic.post.count({ where: { authorId: user.id } })).resolves.toBe(0);
    await expect(attic.profile.count({ where: { userId: user.id } })).resolves.toBe(0);
  });

  it("tracks bulk writes, raw DML, and external truncate repair", async () => {
    if (attic === undefined || pool === undefined) throw new Error("Integration client was not initialized.");

    const emailPrefix = `${runId}-bulk-`;
    const where = { email: { startsWith: emailPrefix } } as const;
    await expect(attic.user.count({ where })).resolves.toBe(0);

    await attic.user.createMany({
      data: Array.from({ length: 3 }, (_, index) => ({
        email: `${emailPrefix}${String(index)}@example.test`,
        name: "before raw update",
      })),
    });
    await expect(attic.user.count({ where })).resolves.toBe(3);

    await attic.$executeRaw`UPDATE ${Prisma.raw(`${quoteIdentifier(schema)}.${quoteIdentifier("app_users")}`)}
                               SET "name" = 'after raw update'
                             WHERE "email" LIKE ${`${emailPrefix}%`}`;
    await expect(attic.user.findFirst({ where })).resolves.toMatchObject({ name: "after raw update" });

    await pool.query(`TRUNCATE TABLE ${quoteIdentifier(schema)}.${quoteIdentifier("app_users")} CASCADE`);
    await expect(attic.$attic.worker.runOnce()).resolves.toBeGreaterThan(0);
    await expect(attic.user.count({ where })).resolves.toBe(0);
  });
});
