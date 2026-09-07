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

**Milestone 1 — scaffold.** The monorepo, package skeleton, build tooling, CI, and compiling
stubs exist; the engine, pg adapter, CLI, and commands are TODO-throw stubs. See the milestone
list in the plan (§11) for what ships next.
