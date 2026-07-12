import type { DMMF } from "@prisma/generator-helper";

interface FixtureFieldOptions {
  readonly kind?: DMMF.FieldKind;
  readonly type?: string;
  readonly isList?: boolean;
  readonly relationName?: string;
  readonly relationFromFields?: readonly string[];
  readonly relationToFields?: readonly string[];
  readonly dbName?: string;
}

interface FixtureModelOptions {
  readonly dbName?: string;
  readonly schema?: string;
  readonly fields?: readonly DMMF.Field[];
}

export function fixtureField(name: string, options: FixtureFieldOptions = {}): DMMF.Field {
  return {
    kind: options.kind ?? "scalar",
    name,
    isRequired: true,
    isList: options.isList ?? false,
    isUnique: false,
    isId: name === "id",
    isReadOnly: false,
    type: options.type ?? "Int",
    hasDefaultValue: false,
    ...(options.relationName === undefined ? {} : { relationName: options.relationName }),
    ...(options.relationFromFields === undefined ? {} : { relationFromFields: [...options.relationFromFields] }),
    ...(options.relationToFields === undefined ? {} : { relationToFields: [...options.relationToFields] }),
    ...(options.dbName === undefined ? {} : { dbName: options.dbName }),
  };
}

export function fixtureModel(name: string, options: FixtureModelOptions = {}): DMMF.Model {
  return {
    name,
    dbName: options.dbName ?? null,
    schema: options.schema ?? null,
    fields: options.fields ?? [fixtureField("id")],
    uniqueFields: [],
    uniqueIndexes: [],
    primaryKey: null,
  };
}

export function fixtureDmmf(models: readonly DMMF.Model[]): DMMF.Document {
  return {
    datamodel: { models, enums: [], types: [], indexes: [] },
    schema: {
      inputObjectTypes: { prisma: [] },
      outputObjectTypes: { model: [], prisma: [] },
      enumTypes: { prisma: [] },
      fieldRefTypes: { prisma: [] },
    },
    mappings: { modelOperations: [], otherOperations: { read: [], write: [] } },
  };
}
