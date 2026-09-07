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

**Milestone 3 — pg adapter.** The core engine, registry validation, and SQL splitting are
implemented; the `/pg` dialect (tracking-table DDL + drift assertion, advisory locking,
node-postgres adapter) is wired into the `/pg` entry and covered by testcontainers integration
tests (CI runs them; locally they skip when Docker is unreachable). CLI and commands are next.
