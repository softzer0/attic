import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { AtticInstallationError } from "../../src/core/errors.js";
import { AtticDatabase, type PrismaRawClient } from "../../src/database.js";
import { buildAtticManifest, renderMigrationSql } from "../../src/generator/index.js";

import { fixtureDmmf, fixtureField, fixtureModel } from "./generator-fixture.js";

function prismaRawClient(database: PGlite): PrismaRawClient {
  return {
    async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
      const result = await database.query(query, values as never[]);
      return result.rows as T;
    },
  } as unknown as PrismaRawClient;
}

describe("generated SQL runtime contract", () => {
  let database: PGlite | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("installs idempotently and captures mapped, request-scoped, and join-table writes", async () => {
    database = new PGlite();
    const user = fixtureModel("User", {
      dbName: "app_users",
      fields: [
        fixtureField("id"),
        fixtureField("tags", {
          kind: "object",
          type: "Tag",
          isList: true,
          relationName: "TagToUser",
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
    });
    const tag = fixtureModel("Tag", {
      fields: [
        fixtureField("id"),
        fixtureField("users", {
          kind: "object",
          type: "User",
          isList: true,
          relationName: "TagToUser",
          relationFromFields: [],
          relationToFields: [],
        }),
      ],
    });
    const dmmf = fixtureDmmf([user, tag]);
    const manifest = buildAtticManifest(dmmf, { namespace: "sql-test" });

    await database.exec(`
      CREATE TABLE public.app_users (id integer PRIMARY KEY, email text NOT NULL);
      CREATE TABLE public."Tag" (id integer PRIMARY KEY, name text NOT NULL);
      CREATE TABLE public."_TagToUser" ("A" integer NOT NULL, "B" integer NOT NULL);
    `);

    const migration = renderMigrationSql(manifest);
    await database.exec(migration);
    await database.exec(migration);
    const installation = new AtticDatabase(prismaRawClient(database), manifest);
    await expect(installation.validateSchema()).resolves.toBeUndefined();
    await database.exec("INSERT INTO public.app_users (id, email) VALUES (1, 'ada@example.test')");

    const first = await database.query<{ tag: string; generation: string; request_id: string | null }>(`
      SELECT tag, generation::text AS generation, request_id::text AS request_id
        FROM attic.outbox
       WHERE namespace = 'sql-test'
       ORDER BY id
    `);
    expect(first.rows).toEqual([{ tag: "model:User", generation: "1", request_id: null }]);

    const requestId = "8c5ec121-2fde-4c76-8b9f-f6f9bb51dfe8";
    await database.exec(`
      BEGIN;
      SELECT set_config('attic.request_id', '${requestId}', true);
      UPDATE public.app_users SET email = 'grace@example.test' WHERE id = 1;
      COMMIT;
      INSERT INTO public."_TagToUser" ("A", "B") VALUES (1, 1);
    `);

    const current = await database.query<{ tag: string; generation: string }>(`
      SELECT tag, generation::text AS generation
        FROM attic.tag_state
       WHERE namespace = 'sql-test'
       ORDER BY tag
    `);
    expect(current.rows).toEqual([
      { tag: "model:Tag", generation: "1" },
      { tag: "model:User", generation: "3" },
    ]);

    const scoped = await database.query<{ request_id: string | null }>(`
      SELECT request_id::text AS request_id
        FROM attic.outbox
       WHERE namespace = 'sql-test' AND generation = 2 AND tag = 'model:User'
    `);
    expect(scoped.rows).toEqual([{ request_id: requestId }]);

    const userTrigger = manifest.triggers.find((trigger) => trigger.table === "app_users");
    if (userTrigger === undefined) throw new Error("Expected the generated User trigger.");
    await database.exec(`ALTER TABLE public.app_users DISABLE TRIGGER "${userTrigger.name}"`);
    await expect(installation.validateSchema()).rejects.toBeInstanceOf(AtticInstallationError);
    await database.exec(`ALTER TABLE public.app_users ENABLE TRIGGER "${userTrigger.name}"`);
    await expect(installation.validateSchema()).resolves.toBeUndefined();

    const otherManifest = buildAtticManifest(dmmf, { namespace: "sql-other" });
    await database.exec(renderMigrationSql(otherManifest));
    await expect(database.exec("SELECT attic.retire_namespace('sql-test')")).rejects.toThrow(/outbox is not empty/u);
    await database.exec("DELETE FROM attic.outbox WHERE namespace = 'sql-test'");
    await database.exec("SELECT attic.retire_namespace('sql-test')");
    await expect(new AtticDatabase(prismaRawClient(database), otherManifest).validateSchema()).resolves.toBeUndefined();
    const remaining = await database.query<{ namespace: string }>(
      "SELECT namespace FROM attic.installation ORDER BY namespace",
    );
    expect(remaining.rows).toEqual([{ namespace: "sql-other" }]);
  });
});
