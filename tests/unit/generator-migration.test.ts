import { describe, expect, it } from "vitest";

import {
  buildAtticManifest,
  collectTriggerTargets,
  quoteIdentifier,
  quoteLiteral,
  renderMigrationSql,
  triggerName,
} from "../../src/generator/index.js";

import { fixtureDmmf, fixtureField, fixtureModel } from "./generator-fixture.js";

describe("Attic PostgreSQL migration generation", () => {
  const alpha = fixtureModel("Alpha", {
    dbName: 'odd "table',
    schema: "tenant-data",
    fields: [
      fixtureField("id"),
      fixtureField("betas", {
        kind: "object",
        type: "Beta",
        isList: true,
        relationName: "AlphaToBeta",
        relationFromFields: [],
        relationToFields: [],
      }),
    ],
  });
  const beta = fixtureModel("Beta", {
    schema: "elsewhere",
    fields: [
      fixtureField("id"),
      fixtureField("alphas", {
        kind: "object",
        type: "Alpha",
        isList: true,
        relationName: "AlphaToBeta",
        relationFromFields: [],
        relationToFields: [],
      }),
    ],
  });

  it("quotes arbitrary PostgreSQL identifiers and literals", () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteLiteral("tenant's \\ cache")).toBe("E'tenant''s \\\\ cache'");
    expect(() => quoteIdentifier("bad\0name")).toThrow(/null byte/);
  });

  it("emits the runtime table contract and durable helper functions", () => {
    const manifest = buildAtticManifest(fixtureDmmf([alpha, beta]), {
      namespace: "tenant:cache",
    });
    const sql = renderMigrationSql(manifest);

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS attic.installation");
    expect(sql).toContain("manifest_hash text NOT NULL");
    expect(sql).toContain("sql_abi_version integer NOT NULL");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS attic.tag_state");
    expect(sql).toContain("PRIMARY KEY (namespace, tag)");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS attic.outbox");
    expect(sql).toContain("locked_by uuid");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION attic.enqueue_tags");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION attic.claim_outbox");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION attic.ack_outbox");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION attic.retry_outbox");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION attic.drop_namespace_triggers");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION attic.retire_namespace");
    expect(sql).toContain("current_setting('attic.request_id', true)");
    expect(sql).toContain("EXCEPTION WHEN invalid_text_representation");
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
    expect(sql).toContain("FROM pg_catalog.pg_trigger AS trg");
    expect(sql).toContain("E'tenant:cache'");
    expect(sql).toContain(`E'${manifest.schemaChecksum}'`);
    expect(sql).toContain("WHERE sql_abi_version IS DISTINCT FROM 1");
    expect(sql).toContain(`sql_abi_version = EXCLUDED.sql_abi_version`);
  });

  it("creates safely quoted statement triggers for models and implicit join tables", () => {
    const manifest = buildAtticManifest(fixtureDmmf([beta, alpha]));
    const sql = renderMigrationSql(manifest);
    const modelTrigger = triggerName("tenant-data", 'odd "table');
    const joinTrigger = triggerName("tenant-data", "_AlphaToBeta");

    expect(sql).toContain(`DROP TRIGGER IF EXISTS "${modelTrigger}" ON "tenant-data"."odd ""table";`);
    expect(sql).toContain(`DROP TRIGGER IF EXISTS "${joinTrigger}" ON "tenant-data"."_AlphaToBeta";`);
    expect(sql).toContain("AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE");
    expect(sql).toContain("EXECUTE FUNCTION attic.capture_statement(E'attic', E'model:Alpha', E'model:Beta');");
  });

  it("coalesces duplicate physical targets and sorts their tags", () => {
    const first = fixtureModel("First", { dbName: "shared", schema: "public" });
    const second = fixtureModel("Second", { dbName: "shared", schema: "public" });
    const manifest = buildAtticManifest(fixtureDmmf([second, first]));

    expect(collectTriggerTargets(manifest)).toEqual([
      { schema: "public", table: "shared", tags: ["model:First", "model:Second"] },
    ]);
  });

  it("keeps trigger names deterministic and within PostgreSQL's identifier limit", () => {
    const name = triggerName("strange-schema", "x".repeat(200));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toBe(triggerName("strange-schema", "x".repeat(200)));
    expect(name).not.toBe(triggerName("strange-schema", "x".repeat(200), "another namespace"));
  });
});
