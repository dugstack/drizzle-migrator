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

**Milestone 5 — commands complete.** Engine, `/pg` adapter, config validation, and the full CLI
are implemented: `migrate` (`--dry-run`), `adopt` (all §5 guards), `status` (`--json`),
`validate`, and `generate` (interactive prompts, `--version/--name/--yes/--register`, canonical
named exports, fully specified ESM registry imports). Next: hardening — README, the bundled
agent skill, changesets, publish provenance.
