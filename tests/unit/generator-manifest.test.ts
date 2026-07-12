import { resolve } from "node:path";

import type { GeneratorConfig } from "@prisma/generator-helper";
import { describe, expect, it } from "vitest";

import {
  buildAtticArtifacts,
  buildAtticManifest,
  deriveImplicitJoinTables,
  renderManifestModule,
  resolvePrismaClientImport,
} from "../../src/generator/index.js";

import { fixtureDmmf, fixtureField, fixtureModel } from "./generator-fixture.js";

describe("Attic generator manifest", () => {
  const category = fixtureModel("Category", {
    dbName: "categories",
    schema: "catalog",
    fields: [
      fixtureField("id"),
      fixtureField("posts", {
        kind: "object",
        type: "Post",
        isList: true,
        relationName: "Featured content",
        relationFromFields: [],
        relationToFields: [],
      }),
    ],
  });
  const post = fixtureModel("Post", {
    dbName: "posts",
    schema: "content",
    fields: [
      fixtureField("id"),
      fixtureField("categories", {
        kind: "object",
        type: "Category",
        isList: true,
        relationName: "Featured content",
        relationFromFields: [],
        relationToFields: [],
      }),
      fixtureField("author", {
        kind: "object",
        type: "User",
        relationName: "PostAuthor",
        relationFromFields: ["authorId"],
        relationToFields: ["id"],
      }),
    ],
  });
  const user = fixtureModel("User", { dbName: "app_users", schema: "identity" });

  it("preserves mappings and emits typed relation dependencies", () => {
    const manifest = buildAtticManifest(fixtureDmmf([post, user, category]), {
      namespace: "tenant_cache",
    });

    expect(manifest.version).toBe(1);
    expect(manifest.namespace).toBe("tenant_cache");
    expect(manifest.schemaChecksum).toMatch(/^[a-f\d]{64}$/);
    expect(manifest.sqlAbiVersion).toBe(1);
    expect(manifest.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: "content",
          table: "posts",
          tags: ["model:Post"],
        }),
      ]),
    );
    expect(Object.keys(manifest.models)).toEqual(["Category", "Post", "User"]);
    expect(manifest.models.Post).toEqual({
      name: "Post",
      dbName: "posts",
      schema: "content",
      tag: "model:Post",
      relations: {
        author: {
          field: "author",
          model: "User",
          isList: false,
          dependencies: ["model:User"],
        },
        categories: {
          field: "categories",
          model: "Category",
          isList: true,
          dependencies: ["model:Category"],
        },
      },
    });
  });

  it("derives named implicit many-to-many tables in the alphabetically first model schema", () => {
    expect(deriveImplicitJoinTables(fixtureDmmf([post, category, user]))).toEqual([
      {
        relationName: "Featured content",
        name: "_Featured content",
        schema: "catalog",
        models: ["Category", "Post"],
        tags: ["model:Category", "model:Post"],
      },
    ]);
  });

  it("does not mistake an unpaired list relation for an implicit join table", () => {
    const lone = fixtureModel("Post", {
      fields: [
        fixtureField("id"),
        fixtureField("categories", {
          kind: "object",
          type: "Category",
          isList: true,
          relationName: "CategoriesOnPosts",
        }),
      ],
    });

    expect(deriveImplicitJoinTables(fixtureDmmf([lone, category]))).toEqual([]);
  });

  it("requires two fields for an implicit many-to-many self relation", () => {
    const userWithOneSelfField = fixtureModel("User", {
      fields: [
        fixtureField("id"),
        fixtureField("followers", {
          kind: "object",
          type: "User",
          isList: true,
          relationName: "UserFollows",
        }),
      ],
    });

    expect(deriveImplicitJoinTables(fixtureDmmf([userWithOneSelfField]))).toEqual([]);
  });

  it("deduplicates the invalidation tag for a valid implicit self relation", () => {
    const userWithSelfRelation = fixtureModel("User", {
      fields: [
        fixtureField("id"),
        fixtureField("followers", {
          kind: "object",
          type: "User",
          isList: true,
          relationName: "UserFollows",
        }),
        fixtureField("following", {
          kind: "object",
          type: "User",
          isList: true,
          relationName: "UserFollows",
        }),
      ],
    });

    expect(deriveImplicitJoinTables(fixtureDmmf([userWithSelfRelation]))).toEqual([
      {
        relationName: "UserFollows",
        name: "_UserFollows",
        schema: "public",
        models: ["User", "User"],
        tags: ["model:User"],
      },
    ]);
  });

  it("produces a stable checksum when model and field declaration order changes", () => {
    const first = buildAtticManifest(fixtureDmmf([category, post, user]));
    const reorderedPost = fixtureModel("Post", {
      dbName: "posts",
      schema: "content",
      fields: [...post.fields].reverse(),
    });
    const second = buildAtticManifest(fixtureDmmf([user, reorderedPost, category]));

    expect(second.schemaChecksum).toBe(first.schemaChecksum);
  });

  it("renders a dependency-free data module with a compile-time manifest check", () => {
    const manifest = buildAtticManifest(fixtureDmmf([user]));
    const source = renderManifestModule(manifest);

    expect(source).toContain('import type { AtticManifest } from "prisma-extension-attic";');
    expect(source).toContain("const data =");
    expect(source).toContain("typeof data & AtticManifest = data");
    expect(source).toContain('"app_users"');
  });

  it("binds the generated manifest to the configured Prisma client type", () => {
    const schemaPath = resolve("fixture", "prisma", "schema.prisma");
    const clientOutput = resolve("fixture", "generated", "prisma");
    const atticOutput = resolve("fixture", "generated", "attic");
    const clientGenerator: GeneratorConfig = {
      name: "client",
      output: { value: clientOutput, fromEnvVar: null },
      provider: { value: "prisma-client", fromEnvVar: null },
      config: {},
      binaryTargets: [],
      previewFeatures: [],
      sourceFilePath: schemaPath,
    };
    const clientImport = resolvePrismaClientImport([clientGenerator], atticOutput, schemaPath);
    const source = renderManifestModule(buildAtticManifest(fixtureDmmf([user])), clientImport);

    expect(clientImport).toBe("../prisma/client.js");
    expect(source).toContain('import type { PrismaClient } from "../prisma/client.js";');
    expect(source).toContain("typeof data & AtticManifest<PrismaClient> = data");
  });

  it("binds the legacy Prisma client generator through its package default", () => {
    const schemaPath = resolve("fixture", "prisma", "schema.prisma");
    const clientGenerator: GeneratorConfig = {
      name: "client",
      output: null,
      provider: { value: "prisma-client-js", fromEnvVar: null },
      config: {},
      binaryTargets: [],
      previewFeatures: [],
      sourceFilePath: schemaPath,
    };

    expect(resolvePrismaClientImport([clientGenerator], resolve("fixture", "attic"), schemaPath)).toBe(
      "@prisma/client",
    );
  });

  it("builds byte-for-byte deterministic artifacts", () => {
    const dmmf = fixtureDmmf([post, user, category]);
    expect(buildAtticArtifacts(dmmf)).toEqual(buildAtticArtifacts(dmmf));
  });

  it("rejects namespaces the runtime cannot use", () => {
    expect(() => buildAtticManifest(fixtureDmmf([user]), { namespace: "tenant cache" })).toThrow(
      /namespace must be 1-64 characters/,
    );
  });
});
