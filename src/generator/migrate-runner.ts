import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import { atticSqlSectionChecksum } from "./migration-section.js";

export interface PrismaCommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type PrismaCommandRunner = (args: readonly string[], options: PrismaCommandOptions) => Promise<void>;

export interface AtticMigrateCliDependencies {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly runPrisma?: PrismaCommandRunner;
  readonly findMigrationFiles?: (cwd: string) => Promise<readonly string[]>;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly makeDirectory?: (path: string, recursive: boolean) => Promise<void>;
  readonly writeTextFile?: (path: string, contents: string, exclusive: boolean) => Promise<void>;
  readonly readTextFile?: (path: string) => Promise<string>;
  readonly removeDirectory?: (path: string) => Promise<void>;
}

export interface AtticMigrateCliResult {
  readonly mode: "forwarded" | "generated";
  readonly migrationFile?: string;
  readonly createdAtticOnly?: boolean;
  readonly applied?: boolean;
}

interface ResolvedDependencies {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => Date;
  readonly runPrisma: PrismaCommandRunner;
  readonly findMigrationFiles: (cwd: string) => Promise<readonly string[]>;
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly makeDirectory: (path: string, recursive: boolean) => Promise<void>;
  readonly writeTextFile: (path: string, contents: string, exclusive: boolean) => Promise<void>;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly removeDirectory: (path: string) => Promise<void>;
}

export class AtticMigrateCliError extends Error {
  public override readonly name = "AtticMigrateCliError";
}

const IGNORED_DIRECTORY_NAMES = new Set([".corepack", ".git", ".tmp", "coverage", "dist", "generated", "node_modules"]);
const CREATE_ONLY_OPTION = "--create-only";
const VALUE_CREATION_OPTIONS = new Set(["--name", "-n"]);

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isHelpRequest(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function hasCreateOnly(args: readonly string[]): boolean {
  return args.some((argument) => argument === CREATE_ONLY_OPTION || argument.startsWith(`${CREATE_ONLY_OPTION}=`));
}

/** Accepts both `attic migrate dev` and an already-stripped `dev` argument list. */
export function normalizeMigrateArguments(args: readonly string[]): string[] {
  return args[0] === "migrate" ? [...args.slice(1)] : [...args];
}

export function withCreateOnly(args: readonly string[]): string[] {
  return hasCreateOnly(args) ? [...args] : [...args, CREATE_ONLY_OPTION];
}

/** Removes flags meaningful only while creating the migration for the apply pass. */
export function withoutCreationOptions(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === CREATE_ONLY_OPTION || argument.startsWith(`${CREATE_ONLY_OPTION}=`)) continue;
    if (VALUE_CREATION_OPTIONS.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--name=") || (argument.startsWith("-n") && argument.length > 2)) continue;
    result.push(argument);
  }
  return result;
}

/** Copies only Prisma options also accepted by `prisma generate`. */
export function extractGenerateOptions(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument.startsWith("--schema=") || argument.startsWith("--config=")) {
      result.push(argument);
      continue;
    }
    if (argument === "--schema" || argument === "--config") {
      result.push(argument);
      const value = args[index + 1];
      if (value !== undefined) {
        result.push(value);
        index += 1;
      }
    }
  }
  return result;
}

function optionValue(args: readonly string[], option: string): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === option) {
      result = args[index + 1];
      index += 1;
    } else if (argument?.startsWith(`${option}=`)) {
      result = argument.slice(option.length + 1);
    }
  }
  return result;
}

export function detectNewMigrationFiles(before: readonly string[], after: readonly string[]): string[] {
  const previous = new Set(before.map(pathKey));
  return after
    .filter((file) => !previous.has(pathKey(file)))
    .map((file) => resolve(file))
    .sort();
}

export function formatAtticMigrationTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new TypeError("Attic migration timestamp must be a valid Date.");
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

export async function findMigrationFiles(cwd: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) await visit(path);
        } else if (entry.isFile() && entry.name.toLowerCase() === "migration.sql") {
          result.push(resolve(path));
        }
      }),
    );
  };

  await visit(resolve(cwd));
  return result.sort();
}

function detectedMigrationRoots(files: readonly string[]): string[] {
  return [...new Set(files.map((file) => resolve(dirname(dirname(file)))))].sort();
}

async function defaultSchemaDirectory(
  cwd: string,
  migrateArgs: readonly string[],
  pathExists: (path: string) => Promise<boolean>,
): Promise<string> {
  const schema = optionValue(migrateArgs, "--schema");
  if (schema) {
    const schemaPath = resolve(cwd, schema);
    return extname(schemaPath).toLowerCase() === ".prisma" ? dirname(schemaPath) : schemaPath;
  }

  const rootSchema = join(cwd, "schema.prisma");
  if (await pathExists(rootSchema)) return cwd;
  const prismaDirectory = join(cwd, "prisma");
  if (await pathExists(join(prismaDirectory, "schema.prisma"))) return prismaDirectory;
  if (await pathExists(prismaDirectory)) return prismaDirectory;
  return cwd;
}

export async function resolveMigrationsRoot(
  cwd: string,
  migrateArgs: readonly string[],
  existingMigrationFiles: readonly string[],
  env: NodeJS.ProcessEnv,
  pathExists: (path: string) => Promise<boolean>,
): Promise<string> {
  const configured = env.ATTIC_MIGRATIONS_PATH?.trim();
  if (configured) return resolve(cwd, configured);

  const schemaDirectory = await defaultSchemaDirectory(cwd, migrateArgs, pathExists);
  const expectedRoot = resolve(schemaDirectory, "migrations");
  if (optionValue(migrateArgs, "--schema") !== undefined) return expectedRoot;
  const roots = detectedMigrationRoots(existingMigrationFiles);
  const matchingRoot = roots.find((root) => pathKey(root) === pathKey(expectedRoot));
  if (matchingRoot) return matchingRoot;
  if (roots.length === 1) return roots[0] ?? expectedRoot;
  if (roots.length > 1) {
    throw new AtticMigrateCliError(
      "Multiple Prisma migration roots were detected. Set ATTIC_MIGRATIONS_PATH or pass --schema explicitly.",
    );
  }
  return expectedRoot;
}

async function createAtticOnlyMigration(
  root: string,
  now: Date,
  dependencies: ResolvedDependencies,
): Promise<{ readonly directory: string; readonly file: string }> {
  await dependencies.makeDirectory(root, true);
  const basename = `${formatAtticMigrationTimestamp(now)}_attic`;

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = (attempt + 1).toString();
    const directory = join(root, attempt === 0 ? basename : `${basename}_${suffix}`);
    if (await dependencies.pathExists(directory)) continue;

    try {
      await dependencies.makeDirectory(directory, false);
      const file = join(directory, "migration.sql");
      await dependencies.writeTextFile(file, "", true);
      return { directory, file };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }

  throw new AtticMigrateCliError("Unable to allocate a unique Attic migration directory.");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runPrisma(args: readonly string[], options: PrismaCommandOptions): Promise<void> {
  const requireFromProject = createRequire(resolve(options.cwd, "package.json"));
  let cliPath: string;
  try {
    cliPath = requireFromProject.resolve("prisma/build/index.js");
  } catch (cause) {
    throw new AtticMigrateCliError(
      "Unable to resolve the Prisma CLI. Install `prisma` in the project running Attic migrations.",
      { cause },
    );
  }

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new AtticMigrateCliError(
            `Prisma command failed${
              signal ? ` with signal ${signal}` : ` with exit code ${code === null ? "unknown" : code.toString()}`
            }.`,
          ),
        );
      }
    });
  });
}

function resolveDependencies(overrides: AtticMigrateCliDependencies): ResolvedDependencies {
  return {
    cwd: resolve(overrides.cwd ?? process.cwd()),
    env: { ...process.env, ...overrides.env },
    now: overrides.now ?? (() => new Date()),
    runPrisma: overrides.runPrisma ?? runPrisma,
    findMigrationFiles: overrides.findMigrationFiles ?? findMigrationFiles,
    pathExists: overrides.pathExists ?? pathExists,
    makeDirectory:
      overrides.makeDirectory ??
      (async (path, recursive) => {
        await mkdir(path, { recursive });
      }),
    writeTextFile:
      overrides.writeTextFile ??
      (async (path, contents, exclusive) => {
        await writeFile(path, contents, { encoding: "utf8", flag: exclusive ? "wx" : "w" });
      }),
    readTextFile: overrides.readTextFile ?? ((path) => readFile(path, "utf8")),
    removeDirectory:
      overrides.removeDirectory ??
      (async (path) => {
        await rm(path, { force: true, recursive: true });
      }),
  };
}

/** Runs the Attic-aware equivalent of `prisma migrate ...`. */
export async function runAtticMigrateCli(
  args: readonly string[],
  dependencyOverrides: AtticMigrateCliDependencies = {},
): Promise<AtticMigrateCliResult> {
  const dependencies = resolveDependencies(dependencyOverrides);
  const migrateArgs = normalizeMigrateArguments(args);

  if (migrateArgs[0] !== "dev" || isHelpRequest(migrateArgs)) {
    await dependencies.runPrisma(["migrate", ...migrateArgs], {
      cwd: dependencies.cwd,
      env: dependencies.env,
    });
    return { mode: "forwarded" };
  }

  const callerRequestedCreateOnly = hasCreateOnly(migrateArgs);
  const before = (await dependencies.findMigrationFiles(dependencies.cwd)).map((file) =>
    resolve(dependencies.cwd, file),
  );
  await dependencies.runPrisma(["migrate", ...withCreateOnly(migrateArgs)], {
    cwd: dependencies.cwd,
    env: dependencies.env,
  });
  const after = (await dependencies.findMigrationFiles(dependencies.cwd)).map((file) =>
    resolve(dependencies.cwd, file),
  );
  const newMigrations = detectNewMigrationFiles(before, after);
  if (newMigrations.length > 1) {
    throw new AtticMigrateCliError(
      `Prisma created multiple migration files (${newMigrations.join(", ")}); refusing to choose one.`,
    );
  }

  let migrationFile: string | undefined = newMigrations[0];
  let createdAtticOnly: { readonly directory: string; readonly file: string } | undefined;
  if (!migrationFile) {
    const root = await resolveMigrationsRoot(
      dependencies.cwd,
      migrateArgs,
      before,
      dependencies.env,
      dependencies.pathExists,
    );
    createdAtticOnly = await createAtticOnlyMigration(root, dependencies.now(), dependencies);
    migrationFile = createdAtticOnly.file;
  }

  try {
    await dependencies.runPrisma(["generate", ...extractGenerateOptions(migrateArgs)], {
      cwd: dependencies.cwd,
      env: { ...dependencies.env, ATTIC_MIGRATION_FILE: resolve(migrationFile) },
    });

    if (createdAtticOnly) {
      const generatedChecksum = atticSqlSectionChecksum(await dependencies.readTextFile(createdAtticOnly.file));
      if (generatedChecksum === undefined) {
        throw new AtticMigrateCliError("The Attic generator did not inject SQL into its migration target.");
      }

      let duplicate = false;
      for (const existingFile of before) {
        const existingChecksum = atticSqlSectionChecksum(await dependencies.readTextFile(existingFile));
        if (existingChecksum === generatedChecksum) {
          duplicate = true;
          break;
        }
      }

      if (duplicate) {
        await dependencies.removeDirectory(createdAtticOnly.directory);
        createdAtticOnly = undefined;
        migrationFile = undefined;
      }
    }
  } catch (error) {
    if (createdAtticOnly) {
      try {
        await dependencies.removeDirectory(createdAtticOnly.directory);
      } catch {
        // Preserve the generator failure; cleanup is best effort for a directory Attic just created.
      }
    }
    throw error;
  }

  if (!callerRequestedCreateOnly) {
    await dependencies.runPrisma(["migrate", ...withoutCreationOptions(migrateArgs)], {
      cwd: dependencies.cwd,
      env: dependencies.env,
    });
  }

  return {
    mode: "generated",
    ...(migrationFile === undefined ? {} : { migrationFile: resolve(migrationFile) }),
    createdAtticOnly: createdAtticOnly !== undefined,
    applied: !callerRequestedCreateOnly,
  };
}
