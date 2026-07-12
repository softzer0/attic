import type { RedisLike } from "../../src/core/types.js";
import { withAttic } from "../../src/extension.js";
import type { AtticManifest } from "../../src/index.js";
import type { PrismaClient } from "../fixtures/generated/client.js";

type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type Expect<Value extends true> = Value;

declare const basePrisma: PrismaClient;
declare const redis: RedisLike;

const manifestData = {
  version: 1,
  sqlAbiVersion: 1,
  namespace: "type-tests",
  schemaChecksum: "type-test-checksum",
  models: {
    User: {
      name: "User",
      dbName: "app_users",
      schema: "public",
      tag: "User",
      relations: {
        posts: { field: "posts", model: "Post", isList: true, dependencies: ["Post"] },
        profile: { field: "profile", model: "Profile", isList: false, dependencies: ["Profile"] },
        tags: { field: "tags", model: "Tag", isList: true, dependencies: ["Tag"] },
      },
    },
    Profile: {
      name: "Profile",
      dbName: "user_profiles",
      schema: "public",
      tag: "Profile",
      relations: {
        user: { field: "user", model: "User", isList: false, dependencies: ["User"] },
      },
    },
    Post: {
      name: "Post",
      dbName: "Post",
      schema: "public",
      tag: "Post",
      relations: {
        author: { field: "author", model: "User", isList: false, dependencies: ["User"] },
        tags: { field: "tags", model: "Tag", isList: true, dependencies: ["Tag"] },
      },
    },
    Tag: {
      name: "Tag",
      dbName: "Tag",
      schema: "public",
      tag: "Tag",
      relations: {
        users: { field: "users", model: "User", isList: true, dependencies: ["User"] },
        posts: { field: "posts", model: "Post", isList: true, dependencies: ["Post"] },
      },
    },
  },
  implicitJoinTables: [],
  triggers: [],
} as const;
const manifest: typeof manifestData & AtticManifest<PrismaClient> = manifestData;

const prisma = basePrisma.$extends(withAttic({ redis, manifest }));

export async function compileTimeExtensionContract(): Promise<void> {
  const normalRequired = await basePrisma.user.findUniqueOrThrow({
    where: { id: 1 },
    include: { profile: true },
  });
  const normalRequiredType: Expect<
    Equal<typeof normalRequired.profile, { id: number; bio: string | null; userId: number } | null>
  > = true;

  const unique = await prisma.user.findUnique({
    where: { id: 1 },
    select: { email: true },
    cacheStrategy: { ttlMs: 1_000, tags: ["custom"] },
  });
  const uniqueType: Expect<Equal<typeof unique, { email: string } | null>> = true;

  const required = await prisma.user.findUniqueOrThrow({
    where: { email: "ada@example.com" },
    include: { profile: true },
    cacheStrategy: false,
  });
  const requiredType: Expect<
    Equal<typeof required.profile, { id: number; bio: string | null; userId: number } | null>
  > = true;

  const first = await prisma.user.findFirst({ select: { id: true }, cacheStrategy: {} });
  const firstType: Expect<Equal<typeof first, { id: number } | null>> = true;

  const firstRequired = await prisma.user.findFirstOrThrow({ omit: { name: true }, cacheStrategy: {} });
  const omittedNameIsUnavailable: Expect<Equal<"name" extends keyof typeof firstRequired ? true : false, false>> = true;

  const uniquePosts = await prisma.user
    .findUnique({ where: { id: 1 }, cacheStrategy: { ttlMs: 1_000 } })
    .posts({ select: { title: true } });
  const uniquePostsType: Expect<Equal<typeof uniquePosts, { title: string }[] | null>> = true;

  const requiredPosts = await prisma.user
    .findUniqueOrThrow({ where: { id: 1 }, cacheStrategy: false })
    .posts({ select: { id: true } });
  const requiredPostsType: Expect<Equal<typeof requiredPosts, { id: number }[]>> = true;

  const firstProfile = await prisma.user.findFirst({ cacheStrategy: {} }).profile({ select: { bio: true } });
  const firstProfileType: Expect<Equal<typeof firstProfile, { bio: string | null } | null>> = true;

  const requiredFirstTags = await prisma.user
    .findFirstOrThrow({ cacheStrategy: { tags: ["User"] } })
    .tags({ select: { name: true } });
  const requiredFirstTagsType: Expect<Equal<typeof requiredFirstTags, { name: string }[]>> = true;

  const many = await prisma.user.findMany({ select: { id: true }, cacheStrategy: { ttlMs: 500 } });
  const manyType: Expect<Equal<typeof many, { id: number }[]>> = true;

  const count = await prisma.user.count({ where: { posts: { some: {} } }, cacheStrategy: {} });
  const countType: Expect<Equal<typeof count, number>> = true;

  const aggregate = await prisma.user.aggregate({ _count: true, cacheStrategy: {} });
  const aggregateType: Expect<Equal<typeof aggregate._count, number>> = true;

  const grouped = await prisma.user.groupBy({ by: ["name"], _count: true, cacheStrategy: {} });
  const groupedName: Expect<Equal<(typeof grouped)[number]["name"], string | null>> = true;

  const raw = await prisma.$attic.queryRaw<{ id: number }[]>({ tags: ["User"] })`SELECT ${1} AS id`;
  const rawType: Expect<Equal<typeof raw, { id: number }[]>> = true;

  const transactionResult = await prisma.$attic.transaction((transaction) => {
    return transaction.user.findUnique({ where: { id: 1 }, select: { email: true } });
  });
  const transactionType: Expect<Equal<typeof transactionResult, { email: string } | null>> = true;

  // @ts-expect-error PostgreSQL does not expose SQL Server's Snapshot isolation level.
  void prisma.$attic.transaction(() => Promise.resolve(undefined), { isolationLevel: "Snapshot" });

  // @ts-expect-error ttlMs must be numeric.
  void prisma.user.findMany({ cacheStrategy: { ttlMs: "1000" } });
  // @ts-expect-error tagged raw caching is mandatory.
  void prisma.$attic.queryRaw({});

  void [
    normalRequired,
    unique,
    required,
    first,
    firstRequired,
    uniquePosts,
    requiredPosts,
    firstProfile,
    requiredFirstTags,
    many,
    count,
    aggregate,
    grouped,
    raw,
    transactionResult,
    normalRequiredType,
    uniqueType,
    requiredType,
    firstType,
    omittedNameIsUnavailable,
    uniquePostsType,
    requiredPostsType,
    firstProfileType,
    requiredFirstTagsType,
    manyType,
    countType,
    aggregateType,
    groupedName,
    rawType,
    transactionType,
  ];
}
