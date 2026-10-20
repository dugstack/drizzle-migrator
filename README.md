# Drizzle Migrator

Config-driven database migrations for [Drizzle ORM](https://orm.drizzle.team) projects.

## Packages

| Package | Purpose |
| --- | --- |
| [`@dugstack/drizzle-migrator`](./packages/core) | Programmatic migration service and dialect adapters. |
| [`@dugstack/drizzle-migrator-cli`](./packages/cli) | `drizzle-migrator` executable, configuration discovery, prompts, and PostgreSQL/MySQL/SQLite connections. |

## Install

```sh
pnpm add -D @dugstack/drizzle-migrator-cli @dugstack/drizzle-migrator
```

Requires Node.js 20+ and Drizzle ORM 0.45.2. Install the core directly when using the
programmatic API; install the CLI for deployment commands.

Read each package README for setup and API guidance.

## Development

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
node .github/scripts/smoke-packages.mjs
```

The consumer smoke check packs both packages, installs them in a temporary app with npm,
and verifies exports plus SQLite generation, validation, migration, and repeat-run behavior.
It requires registry access; PostgreSQL/MySQL integration tests require Docker.

## Implementation docs

Implementation plans and revision records live in
[`agent-implementation-docs`](./agent-implementation-docs).
