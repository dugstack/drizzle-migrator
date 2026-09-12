# `@dugstack/drizzle-migrator-cli`

The executable `migrator` command for [`@dugstack/drizzle-migrator`](../drizzle-migrator). One
config file, no registry files, no bin script — the CLI discovers everything and owns the
Postgres connection wiring.

```sh
pnpm migrator generate
pnpm migrator migrate
pnpm migrator --config ./db/migrator.config.ts status
```

The core package's programmatic API is unchanged: the CLI is a thin layer that loads your config,
auto-discovers migration folders, builds the connection, and forwards every command to the same
core dispatcher the programmatic `Migrator.createCli` uses.

## Install

```sh
npm i -D @dugstack/drizzle-migrator-cli @dugstack/drizzle-migrator
```

The CLI depends on `drizzle-orm`, `pg`, and `jiti` (the TypeScript config loader) directly — no
extra setup. `migrator` is a `bin` entry: with pnpm, `pnpm exec migrator` or a `"migrator"` script
alias; with npm, `npx migrator`.

## Quick start

1. **Create the config** at `drizzle-migrator.config.ts` in the project root:

```ts
// drizzle-migrator.config.ts
export default {
  dialect: "postgres",
  postgres: {
    connectionString: process.env.DATABASE_URL!,
  },
  migratorOutDir: "./src/db/migrator", // where migration entries live
  // drizzleOutDir: "./drizzle",       // optional; wins over drizzle.config's `out`
  // lockName: "myapp:migrator",       // optional; default "drizzle-migrator"
};
```

2. **Generate SQL with drizzle-kit** as usual (`drizzle-kit generate` writes `*.sql` files to the
   SQL directory).

3. **Scaffold the migration entry** — the CLI scans the SQL directory for files not yet claimed by
   a migration:

```sh
pnpm migrator generate --yes
```

4. **Run it:**

```sh
pnpm migrator migrate
```

## Config reference

| field | required | notes |
| --- | --- | --- |
| `dialect` | ✓ | `"postgres"` only in v1; requires the matching `postgres` block |
| `postgres.connectionString` | ✓ | `postgres://` URL or key=value connection string |
| `migratorOutDir` | ✓ | folder scanned for `v<semver>/index.ts` migration entries |
| `drizzleOutDir` | – | drizzle-kit SQL output folder; see resolution below |
| `lockName` | – | advisory-lock name; default `"drizzle-migrator"`. Never change after first deploy |
| `schema`, `tables`, `lock`, `logger` | – | pass-through to the core config (tracking schema, table names, lock timings, logger) |

SQL directory resolution, in order:

1. `drizzleOutDir` in the migrator config — **wins**.
2. The `out` field of `drizzle.config.ts` / `.js` / `.json` found in the working directory.
3. Fallback: `./drizzle`.

Relative paths resolve from `process.cwd()` (where you run the command), not from the config
file's location. `defineConfig` is exported for editor type checking, but a plain-object default
export works too — the CLI re-validates whatever the config file exports.

## Config discovery

The CLI looks for `drizzle-migrator.config.{ts,mts,cts,js,mjs,cjs}` in the working directory.
`--config <path>` overrides it (the extension is appended for you if omitted):

```sh
pnpm migrator --config ./db/migrator.config.ts generate
```

Config and migration entries are loaded through [jiti](https://github.com/unjs/jiti), so they stay
normal TypeScript — no build step, and they can use `process.env` (e.g. `DATABASE_URL`).

## Migration auto-discovery

The CLI scans `<migratorOutDir>/v<semver>/index.ts`. **No manual registry file is needed** — each
version folder's `index.ts` exports one migration:

```ts
// src/db/migrator/v0.0.1/index.ts
import { defineMigration } from "@dugstack/drizzle-migrator";

export const migration_v0_0_1 = defineMigration({
  version: "0.0.1",
  name: "users",
  sqlFiles: ["0001_users.sql"],
  async up(ctx) {
    await ctx.runSqlFile("0001_users.sql");
  },
});
```

Before anything touches the database, discovery validates:

- every folder in `migratorOutDir` is named `v<semver>` (flat `<version>.ts` files are rejected);
- every version folder contains an `index.ts` exporting exactly one `defineMigration({...})`;
- the entry's `version` field matches its folder name (`v0.0.1` ⇒ `"0.0.1"`);
- versions are unique and sorted numerically (`0.10.0 > 0.9.0`).

`generate` scaffolds the next `v<semver>/index.ts` from unapplied SQL files and prints (or, in the
core, optionally registers) the canonical named export — see the core README for the entry rules
and `ctx` reference.

## Commands

| command | flags | notes |
| --- | --- | --- |
| `migrate` | `--dry-run` | the only command a deploy pipeline runs |
| `adopt` | `--from= --to= --force --confirm-database=` | record an existing DB as migrated |
| `status` | `--json` | read-only |
| `generate` | `--version= --name= --yes --register` | scaffold `v<next>/index.ts` from unapplied SQL files |
| `validate` | – | lint the discovered registry; exit 1 with reasons |

Global flags: `--config=<path>`, `--help/-h`. Command behavior, output, audit events, and exit
codes are owned by the core dispatcher — the CLI forwards your argv unchanged.

## How it works

For each command the CLI: loads + validates the config, resolves the SQL directory, discovers
migrations, then opens **one dedicated `pg.Client`**, wraps it with `drizzle(client)`, and binds
`pgDialect` + config + migrations through `createMigrator(...)` before dispatching. The advisory
lock is session-scoped, so acquire/migrate/release always share that single connection — the CLI
owns this wiring; the core stays dialect-token based.

## When to use the core package directly

The CLI covers the standard project shape. Reach for the programmatic API
([`@dugstack/drizzle-migrator`](../drizzle-migrator)) when you need your own bin script, a
non-postgres dialect token, or embedded migration runs — `createMigrator({ dialect, config,
migrations })` and every `Migrator` method are unchanged.

## License

MIT — see [LICENSE](./LICENSE).
