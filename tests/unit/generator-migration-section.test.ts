import { describe, expect, it } from "vitest";

import {
  ATTIC_SQL_END_MARKER,
  ATTIC_SQL_START_MARKER,
  AtticMigrationSectionError,
  atticSqlChecksum,
  injectAtticSql,
  renderAtticSqlSection,
} from "../../src/generator/index.js";

function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("Attic migration SQL sections", () => {
  it("appends a checksummed section without changing existing Prisma SQL", () => {
    const prismaSql = "-- Prisma migration\nCREATE TABLE users (id integer);\n";
    const result = injectAtticSql(prismaSql, "CREATE SCHEMA attic;");

    expect(result.action).toBe("inserted");
    expect(result.sql.startsWith(`${prismaSql}\n${ATTIC_SQL_START_MARKER}`)).toBe(true);
    expect(result.sql).toContain(`-- attic:checksum sha256:${atticSqlChecksum("CREATE SCHEMA attic;")}`);
    expect(result.sql.endsWith(`${ATTIC_SQL_END_MARKER}\n`)).toBe(true);
  });

  it("is byte-for-byte idempotent for an existing current section", () => {
    const first = injectAtticSql("SELECT 'manual';\n", "SELECT 'attic';");
    const second = injectAtticSql(first.sql, "SELECT 'attic';");

    expect(second).toEqual({
      sql: first.sql,
      action: "unchanged",
      checksum: first.checksum,
    });
    expect(count(second.sql, ATTIC_SQL_START_MARKER)).toBe(1);
  });

  it("updates only a valid generated section and preserves surrounding SQL", () => {
    const oldSection = renderAtticSqlSection("SELECT 'old';");
    const existing = `-- before\n${oldSection}\n-- after\n`;
    const result = injectAtticSql(existing, "SELECT 'new';");

    expect(result.action).toBe("updated");
    expect(result.sql.startsWith("-- before\n")).toBe(true);
    expect(result.sql.endsWith("\n-- after\n")).toBe(true);
    expect(result.sql).toContain("SELECT 'new';");
    expect(result.sql).not.toContain("SELECT 'old';");
    expect(count(result.sql, ATTIC_SQL_START_MARKER)).toBe(1);
  });

  it("refuses to overwrite a manually edited generated section", () => {
    const section = renderAtticSqlSection("SELECT 'generated';").replace("generated", "edited");
    expect(() => injectAtticSql(section, "SELECT 'replacement';")).toThrow(AtticMigrationSectionError);
  });

  it("refuses malformed, incomplete, or duplicate marker blocks", () => {
    expect(() => injectAtticSql(ATTIC_SQL_START_MARKER, "SELECT 1;")).toThrow(/incomplete|malformed/);
    const section = renderAtticSqlSection("SELECT 1;");
    expect(() => injectAtticSql(`${section}\n${section}`, "SELECT 2;")).toThrow(/duplicate|more than one/);
  });

  it("accepts CRLF conversion without treating the generated SQL as edited", () => {
    const windowsSql = injectAtticSql("-- manual\r\n", "SELECT 1;\nSELECT 2;")
      .sql.replaceAll("\r\n", "\n")
      .replaceAll("\n", "\r\n");
    const result = injectAtticSql(windowsSql, "SELECT 1;\nSELECT 2;");

    expect(result.action).toBe("unchanged");
    expect(result.sql).toBe(windowsSql);
  });
});
