import { describe, expect, it } from "vitest";

import {
  ATTIC_GLOBAL_TAG,
  AtticManifestError,
  cacheTtlFor,
  resolveCachePolicy,
  resolveDependencyTags,
  type AtticManifest,
} from "../../src/core/index.js";

const manifest: AtticManifest = {
  version: 1,
  sqlAbiVersion: 1,
  namespace: "attic",
  schemaChecksum: "fixture",
  implicitJoinTables: [],
  triggers: [],
  models: {
    User: {
      name: "User",
      dbName: "users",
      schema: "public",
      tag: "model:User",
      relations: {
        posts: {
          field: "posts",
          model: "Post",
          isList: true,
          dependencies: ["join:user-post"],
        },
      },
    },
    Post: {
      name: "Post",
      dbName: "posts",
      schema: "public",
      tag: "model:Post",
      relations: {
        author: {
          field: "author",
          model: "User",
          isList: false,
          dependencies: [],
        },
      },
    },
  },
};

describe("core dependency tags and cache policy", () => {
  it("walks relations in filters and selections and includes manual tags", () => {
    const tags = resolveDependencyTags(
      manifest,
      "User",
      {
        where: { posts: { some: { author: { is: { id: 1 } } } } },
        include: { posts: { include: { author: true } } },
      },
      ["tenant:1", "tenant:1"],
    );

    expect(tags).toEqual([ATTIC_GLOBAL_TAG, "join:user-post", "model:Post", "model:User", "tenant:1"].sort());
  });

  it("does not add relation dependencies for an explicitly disabled selection", () => {
    expect(resolveDependencyTags(manifest, "User", { include: { posts: false } })).toEqual(
      [ATTIC_GLOBAL_TAG, "model:User"].sort(),
    );
  });

  it("fails on stale manifests rather than silently under-tagging", () => {
    expect(() => resolveDependencyTags(manifest, "Missing", {})).toThrow(AtticManifestError);
  });

  it("resolves cache defaults and per-query overrides", () => {
    expect(resolveCachePolicy(false)).toEqual({ enabled: false });

    const policy = resolveCachePolicy(
      { ttlMs: 60_000, tags: ["query", "shared"] },
      { ttlMs: 300_000, negativeTtlMs: 2_000, tags: ["shared", "default"] },
    );
    expect(policy).toEqual({
      enabled: true,
      ttlMs: 60_000,
      negativeTtlMs: 2_000,
      tags: ["default", "query", "shared"],
    });
    if (!policy.enabled) throw new Error("Expected enabled policy");
    expect(cacheTtlFor(null, policy)).toBe(2_000);
    expect(cacheTtlFor([], policy)).toBe(60_000);
  });

  it("rejects invalid TTLs and empty tags", () => {
    expect(() => resolveCachePolicy({ ttlMs: 0 })).toThrow();
    expect(() => resolveCachePolicy({ tags: ["   "] })).toThrow();
  });
});
