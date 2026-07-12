export {
  ATTIC_GENERATOR_MANIFEST,
  ATTIC_GENERATOR_VERSION,
  atticGeneratorCallbacks,
  buildAtticArtifacts,
  generateAttic,
  injectAtticMigrationFile,
  resolvePrismaClientImport,
  runAtticGenerator,
  type ArtifactBuildOptions,
  type GeneratedAtticArtifacts,
} from "./handler.js";
export {
  ATTIC_MANIFEST_VERSION,
  DEFAULT_ATTIC_NAMESPACE,
  DEFAULT_POSTGRES_SCHEMA,
  buildAtticManifest,
  deriveImplicitJoinTables,
  renderManifestModule,
  type ManifestBuildOptions,
} from "./manifest.js";
export { renderMigrationSql } from "./migration.js";
export { buildTriggerManifest, collectTriggerTargets, type TriggerTarget } from "./trigger-targets.js";
export {
  ATTIC_SQL_CHECKSUM_PREFIX,
  ATTIC_SQL_END_MARKER,
  ATTIC_SQL_START_MARKER,
  AtticMigrationSectionError,
  atticSqlChecksum,
  atticSqlSectionChecksum,
  injectAtticSql,
  renderAtticSqlSection,
  type AtticSqlInjectionAction,
  type AtticSqlInjectionResult,
} from "./migration-section.js";
export {
  AtticMigrateCliError,
  detectNewMigrationFiles,
  extractGenerateOptions,
  findMigrationFiles,
  formatAtticMigrationTimestamp,
  normalizeMigrateArguments,
  resolveMigrationsRoot,
  runAtticMigrateCli,
  withCreateOnly,
  withoutCreationOptions,
  type AtticMigrateCliDependencies,
  type AtticMigrateCliResult,
  type PrismaCommandOptions,
  type PrismaCommandRunner,
} from "./migrate-runner.js";
export { quoteIdentifier, quoteLiteral, quoteQualifiedName, triggerName } from "./sql-escaping.js";
