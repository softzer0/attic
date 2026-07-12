import { createHash } from "node:crypto";

const POSTGRES_IDENTIFIER_LIMIT = 63;

function assertNoNullByte(value: string, kind: string): void {
  if (value.includes("\0")) {
    throw new TypeError(`${kind} cannot contain a null byte.`);
  }
}

/** Quotes a PostgreSQL identifier without relying on the active search path. */
export function quoteIdentifier(identifier: string): string {
  assertNoNullByte(identifier, "PostgreSQL identifier");
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Quotes a PostgreSQL string literal. */
export function quoteLiteral(value: string): string {
  assertNoNullByte(value, "PostgreSQL literal");
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

export function quoteQualifiedName(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

/**
 * Produces a readable, collision-resistant trigger name below PostgreSQL's
 * 63-byte identifier limit. The inputs are hashed so mapped identifiers can
 * contain arbitrary Unicode and punctuation safely.
 */
export function triggerName(schema: string, table: string, namespace = "attic"): string {
  const digest = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(schema)
    .update("\0")
    .update(table)
    .digest("hex")
    .slice(0, 16);
  const readable = table
    .normalize("NFKD")
    .replaceAll(/[^a-zA-Z0-9_]/g, "_")
    .replaceAll(/_+/g, "_")
    .slice(0, 32);
  const name = `attic_${readable || "table"}_${digest}`;

  return name.slice(0, POSTGRES_IDENTIFIER_LIMIT);
}
