# `@yourorg/drizzle-migrator`

> **Placeholder scope notice.** `@yourorg` is a placeholder npm scope. Find-and-replace it with
> the real scope before publishing. The same placeholder appears throughout the plan and code.

A standalone, config-driven database migration orchestrator for [Drizzle ORM](https://orm.drizzle.team)
projects. The drizzle client is injected by the consumer; dialect-specific behavior lives behind
subpath exports: `/pg`, `/mysql`, `/sqlite`.

- **Full specification:** [`drizzle-migrator-package-plan.md`](./drizzle-migrator-package-plan.md)
- **Package:** [`packages/drizzle-migrator`](./packages/drizzle-migrator)
- **Docs website:** reserved, empty slot at [`apps/docs`](./apps/docs) (not built in v1, see plan §2)

## Status

**Milestone 2 — core engine.** The engine (`runMigrations`, `adoptMigrations`, `getStatus`),
registry validation, and SQL splitting/ranges are implemented and tested against a fake adapter.
The pg adapter, CLI, and commands are stubs; see the milestone list in the plan (§11) for what
ships next.
