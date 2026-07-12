import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  generatorHandler,
  type DMMF,
  type GeneratorConfig,
  type GeneratorManifest,
  type GeneratorOptions,
} from "@prisma/generator-helper";

import type { AtticManifest } from "../core/types.js";

import {
  buildAtticManifest,
  DEFAULT_ATTIC_NAMESPACE,
  DEFAULT_POSTGRES_SCHEMA,
  renderManifestModule,
} from "./manifest.js";
import { renderMigrationSql } from "./migration.js";
import { injectAtticSql, type AtticSqlInjectionAction } from "./migration-section.js";

export const ATTIC_GENERATOR_VERSION = "0.1.0";
export const ATTIC_GENERATOR_MANIFEST = {
  prettyName: "Attic Prisma cache manifest and PostgreSQL migration generator",
  defaultOutput: "./generated/attic",
  version: ATTIC_GENERATOR_VERSION,
} as const satisfies GeneratorManifest;

export interface ArtifactBuildOptions {
  readonly namespace?: string;
  readonly defaultSchema?: string;
  readonly prismaClientImport?: string;
}

export interface GeneratedAtticArtifacts {
  readonly manifest: AtticManifest;
  readonly manifestTypeScript: string;
  readonly migrationSql: string;
}

export async function injectAtticMigrationFile(
  migrationFile: string,
  generatedSql: string,
): Promise<AtticSqlInjectionAction> {
  const existingSql = await readFile(migrationFile, "utf8");
  const result = injectAtticSql(existingSql, generatedSql);
  if (result.action !== "unchanged") await writeFile(migrationFile, result.sql, "utf8");
  return result.action;
}

function configString(config: GeneratorConfig, key: string, fallback: string, trim = true): string {
  const value = config.config[key];
  if (Array.isArray(value)) throw new TypeError(`Attic generator option ${key} must be a string.`);
  const normalized = trim ? value?.trim() : value;
  return normalized === undefined || normalized.length === 0 ? fallback : normalized;
}

function outputDirectory(options: GeneratorOptions): string {
  const configured = options.generator.output?.value;
  if (!configured) {
    throw new Error(
      "Attic generator output is unresolved. Set `output` in the Prisma generator block or its environment variable.",
    );
  }

  return resolvedOutput(configured, options.schemaPath);
}

function resolvedOutput(output: string, schemaPath: string): string {
  return isAbsolute(output) ? output : resolve(dirname(schemaPath), output);
}

/** Resolves Prisma 7's generated `client.ts` through an ESM `.js` specifier. */
export function resolvePrismaClientImport(
  otherGenerators: readonly GeneratorConfig[],
  atticOutput: string,
  schemaPath: string,
): string | undefined {
  const clients = otherGenerators.filter((generator) =>
    ["prisma-client", "prisma-client-js"].includes(generator.provider.value ?? ""),
  );
  if (clients.length === 0) return undefined;
  if (clients.length > 1) {
    throw new Error("Attic found multiple Prisma client generators and cannot infer which client type to bind.");
  }

  const client = clients[0];
  const clientOutput = client?.output?.value;
  if (client?.provider.value === "prisma-client-js" && !clientOutput) return "@prisma/client";
  if (!clientOutput) throw new Error("The `prisma-client` generator used with Attic must define an output directory.");
  const clientFile = join(
    resolvedOutput(clientOutput, schemaPath),
    client.provider.value === "prisma-client-js" ? "index.js" : "client.js",
  );
  const modulePath = relative(atticOutput, clientFile).replaceAll("\\", "/");
  return modulePath.startsWith(".") ? modulePath : `./${modulePath}`;
}

function assertPostgreSql(options: GeneratorOptions): void {
  if (options.datasources.length === 0) {
    throw new Error("Attic requires a PostgreSQL datasource, but Prisma supplied no datasource metadata.");
  }

  const unsupported = options.datasources.find((datasource) => datasource.activeProvider !== "postgresql");
  if (unsupported) {
    throw new Error(
      `Attic supports PostgreSQL only; datasource ${unsupported.name} uses ${unsupported.activeProvider}.`,
    );
  }
}

/** Pure artifact generation for tests and programmatic integrations. */
export function buildAtticArtifacts(dmmf: DMMF.Document, options: ArtifactBuildOptions = {}): GeneratedAtticArtifacts {
  const manifest = buildAtticManifest(dmmf, options);
  return {
    manifest,
    manifestTypeScript: renderManifestModule(manifest, options.prismaClientImport),
    migrationSql: renderMigrationSql(manifest),
  };
}

/** Prisma's onGenerate implementation, exported for embedding and tests. */
export async function generateAttic(options: GeneratorOptions): Promise<void> {
  assertPostgreSql(options);
  const namespace = configString(options.generator, "namespace", DEFAULT_ATTIC_NAMESPACE, false);
  const defaultSchema = configString(options.generator, "defaultSchema", DEFAULT_POSTGRES_SCHEMA);
  const output = outputDirectory(options);
  const prismaClientImport = resolvePrismaClientImport(options.otherGenerators, output, options.schemaPath);
  const artifacts = buildAtticArtifacts(options.dmmf, {
    namespace,
    defaultSchema,
    ...(prismaClientImport === undefined ? {} : { prismaClientImport }),
  });

  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(resolve(output, "manifest.ts"), artifacts.manifestTypeScript, "utf8"),
    writeFile(resolve(output, "migration.sql"), artifacts.migrationSql, "utf8"),
  ]);

  const migrationFile = process.env.ATTIC_MIGRATION_FILE?.trim();
  if (migrationFile) await injectAtticMigrationFile(resolve(migrationFile), artifacts.migrationSql);
}

export const atticGeneratorCallbacks: Parameters<typeof generatorHandler>[0] = {
  onManifest: () => ATTIC_GENERATOR_MANIFEST,
  onGenerate: generateAttic,
};

/** Registers the stdio JSON-RPC handler. Call only from the generator CLI. */
export function runAtticGenerator(): void {
  generatorHandler(atticGeneratorCallbacks);
}
