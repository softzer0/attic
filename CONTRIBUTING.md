# Contributing

Thanks for helping improve Attic.

## Development

Requirements: Node.js 22.12 or newer, pnpm 10, PostgreSQL, and Redis 7.2 or newer.

```sh
pnpm install
pnpm generate:test-client
pnpm check
```

Generate the test client before opening the TypeScript fixtures in an editor, and regenerate it whenever the fixture schema changes. This keeps type-aware ESLint from treating the intentionally generated client import as unresolved.

If the editor was already open when the client was generated, restart its ESLint and TypeScript language servers so they discard the unresolved-module project state.

Keep changes focused, add tests for behavior changes, and update the public documentation when an API or consistency guarantee changes. Integration tests use isolated PostgreSQL and Redis services configured through environment variables documented in the test fixture.

## Pull requests

- Open an issue first for substantial public API or persistence changes.
- Do not weaken PostgreSQL-as-source-of-truth behavior or transaction boundaries.
- Avoid logging query arguments or cached values; they may contain sensitive data.
- Ensure formatting, lint, type, unit, integration, build, and package checks pass.

By contributing, you agree that your contribution is licensed under the MIT License.

Maintainers should follow the [release guide](docs/releasing.md) rather than publishing directly from a development machine.
