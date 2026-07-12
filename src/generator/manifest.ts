import { createHash } from "node:crypto";

import type { DMMF } from "@prisma/generator-helper";

import { normalizeNamespace } from "../core/namespace.js";
import {
  ATTIC_SQL_ABI_VERSION,
  type AtticManifest,
  type AtticTriggerManifest,
  type ImplicitJoinTableManifest,
  type ModelManifest,
} from "../core/types.js";

import { buildTriggerManifest } from "./trigger-targets.js";

export const ATTIC_MANIFEST_VERSION = 1 as const;
export const DEFAULT_ATTIC_NAMESPACE = "attic";
export const DEFAULT_POSTGRES_SCHEMA = "public";

export interface ManifestBuildOptions {
  readonly namespace?: string;
  readonly defaultSchema?: string;
}

interface ImplicitRelationCandidate {
  readonly relationName: string;
  readonly sourceModel: string;
  readonly targetModel: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonEmpty(value: string | undefined, fallback: string, optionName: string): string {
  const trimmed = value?.trim();
  const result = trimmed === undefined || trimmed.length === 0 ? fallback : trimmed;
  if (result.includes("\0")) throw new TypeError(`${optionName} cannot contain a null byte.`);
  return result;
}

function modelTag(modelName: string): string {
  return `model:${modelName}`;
}

function normalizedSchemaProjection(
  dmmf: DMMF.Document,
  namespace: string,
  defaultSchema: string,
  joins: readonly ImplicitJoinTableManifest[],
  triggers: readonly AtticTriggerManifest[],
): unknown {
  return {
    formatVersion: ATTIC_MANIFEST_VERSION,
    sqlAbiVersion: ATTIC_SQL_ABI_VERSION,
    namespace,
    defaultSchema,
    models: [...dmmf.datamodel.models]
      .sort((left, right) => compareText(left.name, right.name))
      .map((model) => ({
        name: model.name,
        dbName: model.dbName ?? model.name,
        schema: model.schema ?? defaultSchema,
        fields: [...model.fields]
          .sort((left, right) => compareText(left.name, right.name))
          .map((field) => ({
            name: field.name,
            dbName: field.dbName ?? field.name,
            kind: field.kind,
            type: field.type,
            isList: field.isList,
            isRequired: field.isRequired,
            isId: field.isId,
            isUnique: field.isUnique,
            relationName: field.relationName ?? null,
            relationFromFields: field.relationFromFields ?? [],
            relationToFields: field.relationToFields ?? [],
          })),
        primaryKey: model.primaryKey,
        uniqueFields: model.uniqueFields,
        uniqueIndexes: model.uniqueIndexes,
      })),
    enums: [...dmmf.datamodel.enums]
      .sort((left, right) => compareText(left.name, right.name))
      .map((item) => ({
        name: item.name,
        dbName: item.dbName ?? item.name,
        values: [...item.values]
          .sort((left, right) => compareText(left.name, right.name))
          .map((value) => ({ name: value.name, dbName: value.dbName ?? value.name })),
      })),
    implicitJoinTables: joins,
    triggers,
  };
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function implicitRelationCandidates(dmmf: DMMF.Document): ImplicitRelationCandidate[] {
  const modelNames = new Set(dmmf.datamodel.models.map((model) => model.name));
  const result: ImplicitRelationCandidate[] = [];

  for (const model of dmmf.datamodel.models) {
    for (const field of model.fields) {
      if (
        field.kind !== "object" ||
        !field.isList ||
        !field.relationName ||
        !modelNames.has(field.type) ||
        (field.relationFromFields?.length ?? 0) !== 0 ||
        (field.relationToFields?.length ?? 0) !== 0
      ) {
        continue;
      }

      result.push({
        relationName: field.relationName,
        sourceModel: model.name,
        targetModel: field.type,
      });
    }
  }

  return result;
}

/**
 * Derives Prisma's implicit many-to-many tables from the public DMMF relation
 * fields. Prisma does not expose join tables directly, so a group is accepted
 * only when both list-valued relation ends are present.
 */
export function deriveImplicitJoinTables(
  dmmf: DMMF.Document,
  defaultSchema = DEFAULT_POSTGRES_SCHEMA,
): ImplicitJoinTableManifest[] {
  const models = new Map(dmmf.datamodel.models.map((model) => [model.name, model]));
  const groups = new Map<string, ImplicitRelationCandidate[]>();

  for (const candidate of implicitRelationCandidates(dmmf)) {
    const endpoints = [candidate.sourceModel, candidate.targetModel].sort(compareText) as [string, string];
    const key = `${candidate.relationName}\0${endpoints[0]}\0${endpoints[1]}`;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  const joins: ImplicitJoinTableManifest[] = [];
  for (const candidates of groups.values()) {
    const first = candidates[0];
    if (!first) continue;

    const hasReverseEnd = candidates.some(
      (candidate) => candidate.sourceModel === first.targetModel && candidate.targetModel === first.sourceModel,
    );
    const hasBothEnds = first.sourceModel === first.targetModel ? candidates.length >= 2 : hasReverseEnd;
    if (!hasBothEnds) continue;

    const endpoints = [first.sourceModel, first.targetModel].sort(compareText) as [string, string];
    const schemaOwner = models.get(endpoints[0]);
    if (!schemaOwner) continue;

    joins.push({
      relationName: first.relationName,
      name: `_${first.relationName}`,
      schema: schemaOwner.schema ?? defaultSchema,
      models: endpoints,
      tags: [...new Set(endpoints.map(modelTag))],
    });
  }

  return joins.sort((left, right) => compareText(`${left.schema}\0${left.name}`, `${right.schema}\0${right.name}`));
}

function buildModelManifest(model: DMMF.Model, modelNames: ReadonlySet<string>, defaultSchema: string): ModelManifest {
  const relations = Object.fromEntries(
    model.fields
      .filter((field) => field.kind === "object" && modelNames.has(field.type))
      .sort((left, right) => compareText(left.name, right.name))
      .map((field) => [
        field.name,
        {
          field: field.name,
          model: field.type,
          isList: field.isList,
          dependencies: [modelTag(field.type)],
        },
      ]),
  );

  return {
    name: model.name,
    dbName: model.dbName ?? model.name,
    schema: model.schema ?? defaultSchema,
    tag: modelTag(model.name),
    relations,
  };
}

/** Builds the serializable runtime manifest from Prisma's public DMMF. */
export function buildAtticManifest(dmmf: DMMF.Document, options: ManifestBuildOptions = {}): AtticManifest {
  const namespace = normalizeNamespace(options.namespace ?? DEFAULT_ATTIC_NAMESPACE);
  const defaultSchema = nonEmpty(options.defaultSchema, DEFAULT_POSTGRES_SCHEMA, "defaultSchema");
  const modelNames = new Set(dmmf.datamodel.models.map((model) => model.name));
  const implicitJoinTables = deriveImplicitJoinTables(dmmf, defaultSchema);
  const models = Object.fromEntries(
    [...dmmf.datamodel.models]
      .sort((left, right) => compareText(left.name, right.name))
      .map((model) => [model.name, buildModelManifest(model, modelNames, defaultSchema)]),
  );
  const triggers = buildTriggerManifest({ models, implicitJoinTables }, namespace);
  const schemaChecksum = checksum(
    normalizedSchemaProjection(dmmf, namespace, defaultSchema, implicitJoinTables, triggers),
  );

  return {
    version: ATTIC_MANIFEST_VERSION,
    sqlAbiVersion: ATTIC_SQL_ABI_VERSION,
    namespace,
    schemaChecksum,
    models,
    implicitJoinTables,
    triggers,
  };
}

/** Renders a manifest module consumable without generator runtime dependencies. */
export function renderManifestModule(manifest: AtticManifest, prismaClientImport?: string): string {
  const serialized = JSON.stringify(manifest, null, 2);
  const clientImport = prismaClientImport
    ? [`import type { PrismaClient } from ${JSON.stringify(prismaClientImport)};`]
    : [];
  const manifestType = prismaClientImport ? "AtticManifest<PrismaClient>" : "AtticManifest";
  return [
    "// Generated by attic-generator. Do not edit manually.",
    ...clientImport,
    'import type { AtticManifest } from "prisma-extension-attic";',
    "",
    `const data = ${serialized} as const;`,
    "",
    `export const atticManifest: typeof data & ${manifestType} = data;`,
    "",
    "export default atticManifest;",
    "",
  ].join("\n");
}
