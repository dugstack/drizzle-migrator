# Drizzle Migrator

Config-driven database migrations for [Drizzle ORM](https://orm.drizzle.team) projects.

## Packages

| Package | Purpose |
| --- | --- |
| [`@dugstack/drizzle-migrator`](./packages/core) | Programmatic migration service and dialect adapters. |
| [`@dugstack/drizzle-migrator-cli`](./packages/cli) | `migrator` executable, configuration discovery, prompts, and Postgres wiring. |

## Install

```sh
pnpm add @dugstack/drizzle-migrator@alpha
pnpm add -D @dugstack/drizzle-migrator-cli@alpha
```

Read each package README for setup and API guidance.

## Development

```sh
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

## Implementation docs

Implementation plans and revision records live in
[`agent-implementation-docs`](./agent-implementation-docs).
