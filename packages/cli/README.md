# `@dugstack/drizzle-migrator-cli`

The executable `drizzle-migrator` command for [`@dugstack/drizzle-migrator`](../core). One
config file, no registry files, no bin script — the CLI discovers everything, owns the Postgres
connection wiring, and owns the entire command surface: dispatch, flag parsing, prompts, usage
text, output rendering, and exit codes. The core package is a pure programmatic service.

```sh
pnpm exec drizzle-migrator generate
pnpm exec drizzle-migrator migrate
pnpm exec drizzle-migrator --config ./db/migrator.config.ts status
```

## Install

```sh
npm i -D @dugstack/drizzle-migrator-cli
```

The CLI depends on `drizzle-orm`, `pg`, and `jiti` (the TypeScript config loader) directly — no
extra setup. `drizzle-migrator` is a `bin` entry: with pnpm, `pnpm exec drizzle-migrator` or a `"drizzle-migrator"` script
alias; with npm, `npx @dugstack/drizzle-migrator-cli`.

### Agent skill

The CLI's npm tarball ships an agent operating manual at `skills/drizzle-migrator/SKILL.md` —
command tables, migration patterns, operational rules, and verification SQL. Install it where
your agent can read it:

```sh
npx skills add @dugstack/drizzle-migrator-cli
```

or copy `skills/drizzle-migrator/` into the agent's skills directory (`.claude/skills/`,
`.agents/skills/`, …). The tarball path is the canonical source; the bundled command table is
test-diffed against the CLI's single command table.

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
pnpm exec drizzle-migrator generate --yes
```

4. **Run it:**

```sh
pnpm exec drizzle-migrator migrate
```

## Config reference

| field | required | notes |
| --- | --- | --- |
| `dialect` | ✓ | `"postgres"` only in v1; pairs with the optional `postgres` block |
| `postgres.connectionString` | – | `postgres://` URL or key=value connection string. Optional: `generate` and `validate` run without it; `migrate`, `adopt`, and `status` require it and fail before any connection attempt when it is absent |
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
pnpm exec drizzle-migrator --config ./db/migrator.config.ts generate
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

`generate` scaffolds the next `v<semver>/index.ts` from unapplied SQL files and prints (or, with
`--register`, writes) the canonical named export — see the core README for the entry rules and
`ctx` reference.

## Commands

| command | flags | notes |
| --- | --- | --- |
| `migrate` | `--dry-run` | the only command a deploy pipeline runs; requires a database |
| `adopt` | `--from= --to= --force --confirm-database=` | record an existing DB as migrated; requires a database |
| `status` | `--json` | read-only; requires a database |
| `generate` | `--version= --name= --yes --register` | scaffold `v<next>/index.ts` from unapplied SQL files; connection-free |
| `validate` | – | lint the discovered registry; exit 1 with reasons; connection-free without a configured connection string |

Global flags: `--config=<path>`, `--help/-h`.

The command table above is defined once inside the CLI (`src/commands.ts`) and drives everything:
command dispatch, flag validation, usage rendering, and the bundled skill's sync test. The CLI
owns all success/failure output, maps errors to exit codes, and closes every opened connection in
a `finally` block.

Connection rules:

- **No `postgres.connectionString`?** `generate` and `validate` run entirely connection-free; the
  database commands (`migrate`, `adopt`, `status`) fail before any connection attempt.
- **`validate` with a configured connection string** opens one dedicated connection, passes it to
  the core's `validateMigrationEntries` (recording the `validation.started` +
  `validation.completed`/`validation.failed` audit trail), and always closes it. A connection
  failure exits 1.
- `generate` prompts for version and name when `--yes` is absent (empty input accepts the
  default; the defaults come from the core's suggestion API); `--version`/`--name` skip prompts
  individually; `--yes`/`-y` uses every default.

## How it works

For each command the CLI: parses and validates the command + flags against the command table
(before touching the filesystem), loads + validates the config, resolves the SQL directory,
discovers migrations, then — for database commands — opens **one dedicated `pg.Client`**, wraps
it with `drizzle(client)`, and binds `pgDialect` + config + migrations through `createMigrator(...)`
before dispatching. The advisory lock is session-scoped, so acquire/migrate/release always share
that single connection — the CLI owns this wiring; the core stays a pure programmatic service.

## When to use the core package directly

The CLI covers the standard project shape. Reach for the programmatic API
([`@dugstack/drizzle-migrator`](../core)) when you need your own bin script, a
non-postgres dialect token, or embedded migration runs — `createMigrator({ dialect, config,
migrations })` plus the `Migrator` service methods (`runMigrations`, `adoptMigrations`,
`getStatus`, `validateMigrationEntries`, `suggestMigrationEntry`, `generateMigrationEntry`,
`appendAuditEvent`) are the entire surface; the core never parses argv, prints output, or sets
exit codes, so custom CLIs get exactly the same building blocks this executable uses.

## License

MIT — see [LICENSE](./LICENSE).
