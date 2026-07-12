import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AtticMigrateCliError,
  extractGenerateOptions,
  formatAtticMigrationTimestamp,
  renderAtticSqlSection,
  runAtticMigrateCli,
  resolveMigrationsRoot,
  withoutCreationOptions,
  type PrismaCommandOptions,
} from "../../src/generator/index.js";

interface RecordedCommand {
  readonly args: readonly string[];
  readonly options: PrismaCommandOptions;
}

describe("Attic migrate CLI", () => {
  const cwd = resolve("fixture-project");

  it("forwards non-dev migrate commands unchanged", async () => {
    const calls: RecordedCommand[] = [];
    await runAtticMigrateCli(["migrate", "deploy", "--schema", "db/schema.prisma"], {
      cwd,
      env: { TEST_ENV: "yes" },
      runPrisma: (args, options) => {
        calls.push({ args, options });
        return Promise.resolve();
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["migrate", "deploy", "--schema", "db/schema.prisma"]);
  });

  it("runs every generator before injecting and applying a new Prisma migration", async () => {
    const oldFile = join(cwd, "prisma", "migrations", "20260101000000_old", "migration.sql");
    const newFile = join(cwd, "prisma", "migrations", "20260712000000_posts", "migration.sql");
    let scan = 0;
    const calls: RecordedCommand[] = [];
    const args = [
      "dev",
      "--schema",
      "prisma/schema.prisma",
      "--config=prisma.config.ts",
      "--url",
      "postgres://localhost/db",
      "--name",
      "posts",
    ];

    const result = await runAtticMigrateCli(args, {
      cwd,
      findMigrationFiles: () => Promise.resolve(scan++ === 0 ? [oldFile] : [oldFile, newFile]),
      runPrisma: (commandArgs, options) => {
        calls.push({ args: commandArgs, options });
        return Promise.resolve();
      },
    });

    expect(calls.map((call) => call.args)).toEqual([
      ["migrate", ...args, "--create-only"],
      ["generate", "--schema", "prisma/schema.prisma", "--config=prisma.config.ts"],
      [
        "migrate",
        "dev",
        "--schema",
        "prisma/schema.prisma",
        "--config=prisma.config.ts",
        "--url",
        "postgres://localhost/db",
      ],
    ]);
    expect(calls[1]?.options.env.ATTIC_MIGRATION_FILE).toBe(newFile);
    expect(result).toEqual({
      mode: "generated",
      migrationFile: newFile,
      createdAtticOnly: false,
      applied: true,
    });
  });

  it("respects a caller-supplied --create-only flag", async () => {
    const newFile = join(cwd, "prisma", "migrations", "20260712000000_only", "migration.sql");
    let scan = 0;
    const calls: RecordedCommand[] = [];

    const result = await runAtticMigrateCli(["dev", "--create-only"], {
      cwd,
      findMigrationFiles: () => Promise.resolve(scan++ === 0 ? [] : [newFile]),
      runPrisma: (args, options) => {
        calls.push({ args, options });
        return Promise.resolve();
      },
    });

    expect(calls.map((call) => call.args)).toEqual([["migrate", "dev", "--create-only"], ["generate"]]);
    expect(result.applied).toBe(false);
  });

  it("creates a timestamped Attic-only migration when Prisma creates none", async () => {
    const oldFile = join(cwd, "custom", "migrations", "20260101000000_old", "migration.sql");
    const directories = new Set<string>();
    const writes: { path: string; contents: string; exclusive: boolean }[] = [];
    const calls: RecordedCommand[] = [];

    const result = await runAtticMigrateCli(["dev"], {
      cwd,
      now: () => new Date("2026-07-12T14:30:45Z"),
      findMigrationFiles: () => Promise.resolve([oldFile]),
      pathExists: (path) => Promise.resolve(directories.has(path)),
      makeDirectory: (path) => {
        directories.add(path);
        return Promise.resolve();
      },
      writeTextFile: (path, contents, exclusive) => {
        writes.push({ path, contents, exclusive });
        return Promise.resolve();
      },
      readTextFile: (path) =>
        Promise.resolve(path === oldFile ? "-- Existing Prisma migration\n" : renderAtticSqlSection("SELECT 1;")),
      runPrisma: (args, options) => {
        calls.push({ args, options });
        return Promise.resolve();
      },
    });

    const expectedFile = join(cwd, "custom", "migrations", "20260712143045_attic", "migration.sql");
    expect(formatAtticMigrationTimestamp(new Date("2026-07-12T14:30:45Z"))).toBe("20260712143045");
    expect(writes).toEqual([{ path: expectedFile, contents: "", exclusive: true }]);
    expect(calls[1]?.options.env.ATTIC_MIGRATION_FILE).toBe(expectedFile);
    expect(result.migrationFile).toBe(expectedFile);
    expect(result.createdAtticOnly).toBe(true);
  });

  it("removes a redundant Attic-only migration when the generated section is already current", async () => {
    const oldFile = join(cwd, "prisma", "migrations", "20260101000000_current", "migration.sql");
    const section = renderAtticSqlSection("SELECT 1;");
    const removed: string[] = [];
    const calls: RecordedCommand[] = [];

    const result = await runAtticMigrateCli(["dev"], {
      cwd,
      now: () => new Date("2026-07-12T00:00:00Z"),
      findMigrationFiles: () => Promise.resolve([oldFile]),
      pathExists: () => Promise.resolve(false),
      makeDirectory: () => Promise.resolve(),
      writeTextFile: () => Promise.resolve(),
      readTextFile: () => Promise.resolve(section),
      removeDirectory: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
      runPrisma: (args, options) => {
        calls.push({ args, options });
        return Promise.resolve();
      },
    });

    expect(removed).toEqual([join(cwd, "prisma", "migrations", "20260712000000_attic")]);
    expect(calls.map((call) => call.args)).toEqual([
      ["migrate", "dev", "--create-only"],
      ["generate"],
      ["migrate", "dev"],
    ]);
    expect(result).toEqual({ mode: "generated", createdAtticOnly: false, applied: true });
  });

  it("cleans up a newly-created Attic-only directory if generation fails", async () => {
    const removed: string[] = [];
    let command = 0;

    await expect(
      runAtticMigrateCli(["dev"], {
        cwd,
        now: () => new Date("2026-07-12T00:00:00Z"),
        findMigrationFiles: () => Promise.resolve([]),
        pathExists: () => Promise.resolve(false),
        makeDirectory: () => Promise.resolve(),
        writeTextFile: () => Promise.resolve(),
        removeDirectory: (path) => {
          removed.push(path);
          return Promise.resolve();
        },
        runPrisma: () => {
          command += 1;
          return command === 2 ? Promise.reject(new Error("generate failed")) : Promise.resolve();
        },
      }),
    ).rejects.toThrow("generate failed");

    expect(removed).toEqual([join(cwd, "migrations", "20260712000000_attic")]);
  });

  it("refuses to guess when Prisma creates multiple migration files", async () => {
    let scan = 0;
    const runPrisma = vi.fn(() => Promise.resolve());
    await expect(
      runAtticMigrateCli(["dev"], {
        cwd,
        findMigrationFiles: () =>
          Promise.resolve(scan++ === 0 ? [] : [join(cwd, "a", "migration.sql"), join(cwd, "b", "migration.sql")]),
        runPrisma,
      }),
    ).rejects.toBeInstanceOf(AtticMigrateCliError);
    expect(runPrisma).toHaveBeenCalledTimes(1);
  });

  it("forwards dev help without touching migrations", async () => {
    const runPrisma = vi.fn(() => Promise.resolve());
    const findMigrationFiles = vi.fn(() => Promise.resolve([]));
    await runAtticMigrateCli(["dev", "--help"], { cwd, runPrisma, findMigrationFiles });

    expect(runPrisma).toHaveBeenCalledWith(["migrate", "dev", "--help"], expect.objectContaining({ cwd }));
    expect(findMigrationFiles).not.toHaveBeenCalled();
  });

  it("extracts generation flags and removes only creation flags", () => {
    const args = [
      "dev",
      "--schema=db/schema.prisma",
      "--config",
      "prisma.config.ts",
      "--name=change",
      "--url",
      "postgres://db",
      "--create-only",
    ];
    expect(extractGenerateOptions(args)).toEqual(["--schema=db/schema.prisma", "--config", "prisma.config.ts"]);
    expect(withoutCreationOptions(args)).toEqual([
      "dev",
      "--schema=db/schema.prisma",
      "--config",
      "prisma.config.ts",
      "--url",
      "postgres://db",
    ]);
  });

  it("keeps an explicit schema isolated from unrelated migration roots", async () => {
    const unrelated = join(cwd, "other", "migrations", "20260101000000_old", "migration.sql");
    await expect(
      resolveMigrationsRoot(cwd, ["dev", "--schema", "services/api/schema.prisma"], [unrelated], {}, () =>
        Promise.resolve(false),
      ),
    ).resolves.toBe(join(cwd, "services", "api", "migrations"));
  });
});
