import { runAtticMigrateCli } from "./migrate-runner.js";

void runAtticMigrateCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`attic migrate: ${message}\n`);
  process.exitCode = 1;
});
