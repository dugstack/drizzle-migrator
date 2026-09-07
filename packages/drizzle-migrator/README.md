# `@yourorg/drizzle-migrator`

> **Placeholder scope notice.** `@yourorg` is a placeholder npm scope — find-and-replace it with
> the real scope before publishing.

A standalone, config-driven database migration orchestrator for [Drizzle ORM](https://orm.drizzle.team)
projects. The drizzle client is injected by the consumer; dialect-specific behavior lives behind
subpath exports: `/pg`, `/mysql`, `/sqlite`.

- `.` — core: `defineMigration`, `defineConfig`, and the public types
- `/pg` — v1 reference dialect (Postgres via `drizzle-orm/node-postgres`)
- `/mysql`, `/sqlite` — stubs that throw `not implemented in v1`

The full specification lives at the repository root (`drizzle-migrator-package-plan.md`).
Complete documentation ships in Milestone 6.
