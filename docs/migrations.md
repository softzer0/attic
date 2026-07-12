# Prisma migration workflow

Attic uses a Prisma generator to turn schema model metadata into a runtime manifest and reviewable PostgreSQL SQL.

## Generated artifacts

With the generator output from the README schema example, `prisma generate` creates:

- `src/generated/attic/manifest.ts`, the typed runtime contract containing the namespace, schema checksum, SQL ABI version, model and table mappings, relation dependencies, implicit join tables, and expected trigger descriptors.
- `src/generated/attic/migration.sql`, the deterministic PostgreSQL installation SQL used when creating migrations.

The manifest contains schema metadata only—never database credentials or query values. Import it when applying the extension:

```ts
import { withAttic } from "prisma-extension-attic";
import { atticManifest } from "./generated/attic/manifest.js";

const prisma = basePrisma.$extends(withAttic({ redis, manifest: atticManifest }));
```

Both files are generated and must not be edited. Run `pnpm prisma generate` after changing the Prisma schema or Attic generator configuration when you are not creating a migration. The migration wrapper runs every configured generator before injecting Attic SQL, keeping Prisma Client and the Attic manifest aligned with the installation committed in the migration.

Use Attic's thin migration wrapper whenever `prisma migrate dev` would create a migration:

```sh
pnpm exec attic migrate dev --name describe_the_change
```

The wrapper performs four ordered steps:

1. Runs `prisma migrate dev --create-only` with the original schema/config options.
2. Runs every configured Prisma generator, with the new migration as Attic's injection target.
3. Injects or updates exactly one checksummed `-- <attic:generated>` section without changing Prisma's SQL.
4. Runs `prisma migrate dev` again to apply the complete migration, unless the caller supplied `--create-only`.

If Prisma has no schema diff but the generated Attic SQL changed after a package upgrade, the wrapper creates a deduplicated Attic-only migration. This keeps SQL ABI upgrades reviewable and deployable without inventing a Prisma model change.

For a review gate, pass `--create-only`, inspect the complete `migration.sql`, then apply it with the normal `prisma migrate dev` command. The Attic SQL is already part of the migration at that point.

`attic migrate deploy`, `status`, `resolve`, and other non-development subcommands are forwarded to Prisma unchanged. This is intentional: deployed migration files are immutable and already contain Attic's SQL.

Prisma does not expose a third-party pre-apply hook, so a plain `prisma migrate dev` cannot be intercepted safely. Point your project's migration script at `attic migrate dev`:

```json
{
  "scripts": {
    "db:migrate": "attic migrate dev"
  }
}
```

The sibling generated `migration.sql` remains a review artifact; do not copy it manually. SQL inside an existing generated marker is fail-closed: if it was hand-edited, Attic refuses to overwrite it. SQL outside the marker is preserved.

Set `ATTIC_MIGRATIONS_PATH` only when a nonstandard repository layout prevents automatic migration-root detection. The Attic generator block may use any name because the wrapper runs every configured generator.

Runtime startup compares PostgreSQL with the imported generated manifest and fails on missing or stale metadata. Create and apply a migration after schema changes so mapped tables, schemas, relations, implicit join tables, and triggers stay aligned.

Runtime validation also compares the installed SQL ABI and inspects every live trigger. A dropped, disabled, moved, or argument-modified trigger fails startup and reports stale schema health. Changing the generator namespace requires a coordinated retirement of the old namespace after its outbox drains:

```sql
SELECT attic.retire_namespace('old-namespace');
```

Do not retire an active namespace. See the operations guide for the full sequence.
