# `@dugstack/drizzle-migrator`

> **Scope notice.** The npm scope for this package is `@dugstack`. The same scope appears
> throughout the plan and code.

A standalone, config-driven database migration orchestrator for [Drizzle ORM](https://orm.drizzle.team)
projects. The drizzle client is injected by the consumer; dialect-specific behavior lives behind
subpath exports: `/pg`, `/mysql`, `/sqlite`.

- **Full specification:** [`drizzle-migrator-package-plan.md`](./drizzle-migrator-package-plan.md)
- **Package (core + adapters):** [`packages/core`](./packages/core) — a
  pure programmatic service (no CLI)
- **Package (executable):** [`packages/cli`](./packages/cli) —
  the `migrator` command: sole CLI owner (command table, dispatch, prompts, usage), config and
  migration auto-discovery, Postgres wiring, and the bundled agent skill
  ([Revision 3](./drizzle-migrator-revision-3-cli-separation.md))
- **Docs website:** reserved, empty slot at [`apps/docs`](./apps/docs) (not built in v1, see plan §2)

## Status

**Milestone 6 — hardening complete; Revision 3 (CLI separation) implemented.** The core package
is a pure programmatic service (`runMigrations`, `adoptMigrations`, `getStatus`,
`validateMigrationEntries`, `suggestMigrationEntry`, `generateMigrationEntry`,
`appendAuditEvent`); the `@dugstack/drizzle-migrator-cli` executable owns the entire command
surface — the single command table, argv parsing, prompts, usage, output, exit codes, optional
Postgres configuration, and the bundled agent skill (`skills/drizzle-migrator/SKILL.md`,
test-synced against the CLI command table). Changesets and the provenance release pipeline are
wired for alpha releases. Initial publishing requires a manual workflow dispatch and `NPM_TOKEN`.
