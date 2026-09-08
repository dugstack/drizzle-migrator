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

**Milestone 6 — hardening complete.** All five CLI commands, the `/pg` adapter, the full
consumer README, and the bundled agent skill (`skills/drizzle-migrator/SKILL.md`, test-synced
against the CLI dispatch table) are in place; changesets and the provenance release pipeline are
wired but gated off until the real npm scope and `NPM_TOKEN` exist. Publishing is intentionally
not possible until then.
