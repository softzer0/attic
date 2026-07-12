import { createHash } from "node:crypto";

export const ATTIC_SQL_START_MARKER = "-- <attic:generated>";
export const ATTIC_SQL_CHECKSUM_PREFIX = "-- attic:checksum sha256:";
export const ATTIC_SQL_END_MARKER = "-- </attic:generated>";

const SECTION_PATTERN =
  /-- <attic:generated>\r?\n-- attic:checksum sha256:([a-f\d]{64})\r?\n([\s\S]*?)\r?\n-- <\/attic:generated>/g;

export type AtticSqlInjectionAction = "inserted" | "updated" | "unchanged";

export interface AtticSqlInjectionResult {
  readonly sql: string;
  readonly action: AtticSqlInjectionAction;
  readonly checksum: string;
}

export class AtticMigrationSectionError extends Error {
  public override readonly name = "AtticMigrationSectionError";
}

function occurrences(source: string, value: string): number {
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = source.indexOf(value, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + value.length;
  }
}

function normalizePayload(sql: string): string {
  const normalized = sql.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (normalized.length === 0) throw new AtticMigrationSectionError("Generated Attic SQL must not be empty.");
  if (
    normalized.includes(ATTIC_SQL_START_MARKER) ||
    normalized.includes(ATTIC_SQL_CHECKSUM_PREFIX) ||
    normalized.includes(ATTIC_SQL_END_MARKER)
  ) {
    throw new AtticMigrationSectionError("Generated Attic SQL must not contain Attic migration markers.");
  }
  return normalized;
}

export function atticSqlChecksum(sql: string): string {
  return createHash("sha256").update(normalizePayload(sql)).digest("hex");
}

export function renderAtticSqlSection(sql: string): string {
  const payload = normalizePayload(sql);
  const checksum = atticSqlChecksum(payload);
  return [ATTIC_SQL_START_MARKER, `${ATTIC_SQL_CHECKSUM_PREFIX}${checksum}`, payload, ATTIC_SQL_END_MARKER].join("\n");
}

function parseExistingSection(source: string): RegExpExecArray | undefined {
  const markerCounts = [
    occurrences(source, ATTIC_SQL_START_MARKER),
    occurrences(source, ATTIC_SQL_CHECKSUM_PREFIX),
    occurrences(source, ATTIC_SQL_END_MARKER),
  ];
  if (markerCounts.every((count) => count === 0)) return undefined;
  if (markerCounts.some((count) => count !== 1)) {
    throw new AtticMigrationSectionError(
      "Migration contains malformed or duplicate Attic markers; refusing to modify it.",
    );
  }

  SECTION_PATTERN.lastIndex = 0;
  const match = SECTION_PATTERN.exec(source);
  if (!match) {
    throw new AtticMigrationSectionError("Migration contains an incomplete Attic section; refusing to modify it.");
  }
  if (SECTION_PATTERN.exec(source)) {
    throw new AtticMigrationSectionError("Migration contains more than one Attic section; refusing to modify it.");
  }

  const declaredChecksum = match[1];
  const payload = match[2];
  if (!declaredChecksum || payload === undefined || atticSqlChecksum(payload) !== declaredChecksum) {
    throw new AtticMigrationSectionError(
      "The generated Attic SQL section was edited after generation; refusing to overwrite it.",
    );
  }
  return match;
}

/** Returns and validates the checksum of an existing Attic section. */
export function atticSqlSectionChecksum(source: string): string | undefined {
  return parseExistingSection(source)?.[1];
}

/**
 * Appends or replaces only Attic's marked SQL section. All SQL outside the
 * section is retained byte-for-byte, and modified generated sections fail
 * closed instead of overwriting manual changes.
 */
export function injectAtticSql(existingSql: string, generatedSql: string): AtticSqlInjectionResult {
  const generatedSection = renderAtticSqlSection(generatedSql);
  const checksum = atticSqlChecksum(generatedSql);
  const existing = parseExistingSection(existingSql);
  const lineEnding = existingSql.includes("\r\n") ? "\r\n" : "\n";
  const formattedSection = generatedSection.replaceAll("\n", lineEnding);

  if (!existing) {
    const separator =
      existingSql.length === 0 ? "" : existingSql.endsWith(lineEnding) ? lineEnding : lineEnding.repeat(2);
    return {
      sql: `${existingSql}${separator}${formattedSection}${lineEnding}`,
      action: "inserted",
      checksum,
    };
  }

  if (existing[1] === checksum) {
    return { sql: existingSql, action: "unchanged", checksum };
  }

  const start = existing.index;
  const end = start + existing[0].length;
  return {
    sql: `${existingSql.slice(0, start)}${formattedSection}${existingSql.slice(end)}`,
    action: "updated",
    checksum,
  };
}
