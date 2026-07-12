# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-12

### Added

- Type-safe Prisma 7 cache-aside reads backed by Redis, with PostgreSQL remaining authoritative.
- Durable model-tag invalidation through PostgreSQL statement triggers and an outbox reconciler.
- A Prisma generator for schema-aware manifests, relation dependencies, mapped tables, and trigger SQL.
- Automatic, checksummed Attic SQL injection through `attic migrate dev`.
- Schema-aware interactive transaction typing and preserved Prisma fluent relation chaining on cached single-record reads.
- An optional NestJS dynamic module with synchronous and asynchronous registration and managed lifecycle support.

### Consistency and safety

- Startup and health validation for the installed SQL ABI, manifest checksum, and live trigger definitions.
- Fail-safe recovery detection when Redis generations are ahead of restored PostgreSQL state.
- Explicit old-namespace retirement for coordinated namespace changes.

### Developer experience and documentation

- An opt-in write-throughput benchmark covering baseline PostgreSQL and Attic write paths.
- Production guidance for outbox monitoring, Redis outages, backup restoration, retention, and namespace changes.
- Copyable first-use recipes and clear guidance on the boundary between Attic and Redis-first write-behind systems.

[0.1.0]: https://github.com/softzer0/attic/releases/tag/v0.1.0
