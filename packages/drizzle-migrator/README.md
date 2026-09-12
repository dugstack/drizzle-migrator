# `@dugstack/drizzle-migrator`

> **Scope notice.** The npm scope for this package is `@dugstack` — it appears throughout the
> docs, examples, and the generated migration entries.

A standalone, config-driven database migration orchestrator for [Drizzle ORM](https://orm.drizzle.team)
projects. The drizzle client is injected by the consumer; dialect-specific behavior lives behind
subpath exports: [`/pg`](#dialects), `/mysql`, `/sqlite`.

## Why not drizzle's built-in `migrate()`?

Drizzle's built-in `migrate()` has gaps every real project eventually hits:

- it tracks migrations by **hash of the SQL file** — editing an applied file breaks integrity
  checks;
- it has **no story for data remaps** interleaved with generated DDL (the classic "add nullable
  column, backfill, then add NOT NULL" flow);
- it has **no audit trail** — when a migration fails at 3am you cannot answer "what was
  attempted, when, and what was the error" from the database;
- it has **no safe way to adopt an existing database** — recording a database as already-migrated
  without executing anything fails silently if done wrong.

This package fixes all four:

1. **Semver versions** (`v0.0.3/`) as the unit of migration, sorted numerically (`0.10.0 > 0.9.0`).
2. **Per-migration transactions** — the version row is committed *inside* the migration
   transaction: applied-and-recorded, or neither.
3. **Typed SQL files** — `ctx.runSqlFile` accepts only the names the migration declares, at
   compile time.
4. **An event audit log** — every migrator lifecycle event plus app events appended from inside
   migrations.
5. **A guarded `adopt` command** for existing databases.
6. **`status`, `dry-run`, and `generate`** for day-to-day operation.
7. **Config-driven everything** — one project config file; no set-in-stone names or paths.
8. **A bundled agent skill** so AI coding agents use the migrator correctly out of the box.

## Install

```sh
npm i @dugstack/drizzle-migrator drizzle-orm pg
```

The package has zero runtime dependencies; `drizzle-orm` and `pg` are peer dependencies.

### Agent skill

The npm tarball ships an agent operating manual at `skills/drizzle-migrator/SKILL.md` — command
tables, migration patterns, operational rules, and verification SQL. Install it where your agent
can read it:

```sh
npx skills add @dugstack/drizzle-migrator
```

or copy `skills/drizzle-migrator/` into the agent's skills directory (`.claude/skills/`,
`.agents/skills/`, …). The tarball path is the canonical source.

## Quick start

One config file, one bin script — that is the entire consumer setup.

```ts
// app: src/db/migrator.config.ts
import { defineConfig } from "@dugstack/drizzle-migrator";

export const migratorConfig = defineConfig({
  sqlDir: "./drizzle",            // drizzle-kit SQL output folder (default "./drizzle")
  migrationsDir: "./src/db/migrator/versions", // migration entries (default "./migrations")
  schema: "migrations",           // pg: tracking schema (default "migrations")
  tables: {
    versions: "migration_versions",
    logs: "migration_logs",
  },
  lockName: "myapp:db:migrations",  // REQUIRED. Unique per app. Never change after deploy.
  lock: { waitTimeoutMs: 600_000, retryIntervalMs: 5_000 },
  logger: console,
});
```

```ts
// app: scripts/migrate.ts — ~20 lines, the whole wiring
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createMigrator } from "@dugstack/drizzle-migrator";
import { pgDialect } from "@dugstack/drizzle-migrator/pg";
import { migratorConfig } from "../src/db/migrator.config.js";
import { migrations } from "../src/db/migrator/versions/index.js";

const migrator = createMigrator({
  dialect: pgDialect,
  config: migratorConfig,
  migrations,
});

await migrator.createCli({
  connect: async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return { db: drizzle(client), close: () => client.end() };
  },
});
```

For programmatic execution, call `await migrator.runMigrations({ db })`. Config, migrations, and
dialect bind once during construction.

Then: `node scripts/migrate.ts migrate`.

> **pg advisory locks are session-scoped.** The `connect` factory must hand back a **single
> dedicated connection** (a `pg.Client`, not a shared `Pool`) — acquire, migrate, and release
> must share one connection. Do not share the client.

## Writing migrations

One folder per version, registered explicitly — the package never auto-discovers files:

```
app/src/db/migrator/versions/
  index.ts            # the registry — explicit, statically imported
  v0.0.1/index.ts
  v0.0.2/index.ts
  v0.1.0/
    index.ts
    backfill.ts       # helpers live inside their version folder
```

```ts
// v0.0.3/index.ts — canonical named export: migration_v<major>_<minor>_<patch>
import { defineMigration } from "@dugstack/drizzle-migrator";

export const migration_v0_0_3 = defineMigration({
  version: "0.0.3",
  name: "add-games",
  sqlFiles: ["0003_games.sql"],   // compile-time allowlist for ctx.runSqlFile
  async up(ctx) {
    await ctx.runSqlFile("0003_games.sql", { to: 2 });   // from is inclusive, to is exclusive
    await ctx.execute(`UPDATE "games" SET "slug" = lower("title")`);
  },
});
```

```ts
// versions/index.ts — registry imports are fully specified ESM paths
import { migration_v0_0_3 } from "./v0.0.3/index.js";

export const migrations = [migration_v0_0_3];
```

Rules the engine enforces before touching the database: version format, no duplicate versions,
folder name must be exactly `v` + `version` (flat `<version>.ts` files are rejected), no SQL
file claimed by two migrations, every declared file must exist under `sqlDir`. The registry is
sorted numerically — input order is irrelevant.

`sqlFiles` are drizzle-kit outputs split on `--> statement-breakpoint`. `runSqlFile(file,
{ from?, to? })`: `from` inclusive (default 0), `to` **exclusive** (default: end of file). There
is no `-1` sentinel; invalid ranges throw before anything executes.

### `ctx`

| member | notes |
| --- | --- |
| `ctx.tx` | the drizzle transaction handle for this migration |
| `ctx.execute(sql)` | runs one raw statement inside the transaction |
| `ctx.runSqlFile(file, range?)` | typed to the declared `sqlFiles`; splits + slices statements |
| `ctx.audit(kind, payload?)` | appends an app event **inside** the transaction (rolls back with it) |

## Transactions and the audit trail

Each pending migration runs in its own transaction; the version row (`origin: 'executed'`) is
inserted **inside the same transaction** — applied-and-recorded, or neither.

Engine lifecycle events (`run.started`, `run.applied`, `run.failed`, `run.adopted`, `lock.*`,
`bootstrap.completed`, `cli.command`, `dryrun.completed`) are written **outside** transactions so
they survive rollbacks. `ctx.audit(...)` writes **inside** the transaction — appropriate for
progress notes tied to the migration's outcome. Audit-write failures are logged, never thrown;
they never mask the real error.

A migration attempt is reconstructed as: event `run.started` with no matching `run.applied` /
`run.failed` for the same `run_id` + version ⇒ the migrator process died mid-flight (see
[Forensics](#forensics-verification-sql)).

## Commands

| command | flags | notes |
| --- | --- | --- |
| `migrate` | `--dry-run` | the only command a deploy pipeline runs |
| `adopt` | `--from= --to= --force --confirm-database=` | record an existing DB as migrated |
| `status` | `--json` | read-only |
| `generate` | `--version= --name= --yes --register` | scaffold `v<next>/index.ts` from unapplied SQL files |
| `validate` | – | registry lint; exit 1 with reasons |

`generate` is interactive by default (prompts via `node:readline/promises`, empty input accepts
the default); flags skip prompts individually; `--yes`/`-y` uses every default. It always emits
the canonical named export and, with `--register`, appends the fully specified ESM import to the
registry when it recognizes the `export const migrations` pattern — otherwise it prints the
exact snippet to paste. It never overwrites an existing entry.

## Adopting an existing database

`adopt` records version rows with `origin: 'adopted'` and **never executes migration SQL**.

- Range is `[from ?? first, to ?? last]`, inclusive; unknown versions abort with the registry listed.
- Requires `--confirm-database=<name>` matching the connected database.
- Refuses when the `CI` env var is set — adoption is a manual, one-time step.
- Refuses a database with no tables in its default schema (a real `migrate` is wanted).
- Without `--force`, aborts when the versions table already has rows; with `--force`, the
  effective range starts **above the highest recorded version**.

## Operational rules

- Never edit an applied migration; add a new semver migration.
- Never change `lockName` after deployment.
- No network calls or file writes inside migrations; deterministic and retryable after failure.
- Avoid non-transactional statements (`CREATE INDEX CONCURRENTLY`) inside migrations — run them
  as a separate operational step.
- Never run migrations from application startup; deployment commands only.
- Migrator tracking tables must never be added to the app's drizzle-kit schema input.

## Forensics / verification SQL

Defaults shown — substitute your configured schema/table names.

Current version:

```sql
SELECT version, name, origin, applied_at
FROM "migrations"."migration_versions"
ORDER BY applied_at DESC
LIMIT 1;
```

Stuck runs (migrator died mid-flight):

```sql
SELECT l.run_id, l.version, l.at
FROM "migrations"."migration_logs" l
WHERE l.kind = 'run.started'
  AND NOT EXISTS (
    SELECT 1 FROM "migrations"."migration_logs" f
    WHERE f.run_id = l.run_id
      AND f.version = l.version
      AND f.kind IN ('run.applied', 'run.failed')
  );
```

Adopted (recorded-but-never-executed) versions:

```sql
SELECT version, name, applied_at
FROM "migrations"."migration_versions"
WHERE origin = 'adopted'
ORDER BY applied_at;
```

Recent entries:

```sql
SELECT at, kind, version, detail
FROM "migrations"."migration_logs"
ORDER BY at DESC
LIMIT 20;
```

## Dialects

- `@dugstack/drizzle-migrator` — `createMigrator`, `Migrator`, `defineMigration`,
  `defineConfig`, plus `Migration`, `MigrationContext`, `RunSqlFileRange`, `MigratorConfig`,
  `RunMigrationsResult`, `AdoptResult`, `StatusReport`, `GenerateResult`, `ValidateResult`,
  `MigratorLogger`, and `AuditLogEntry` types.
- `@dugstack/drizzle-migrator/pg` — `pgDialect`, `PgDialect`.
- `@dugstack/drizzle-migrator/mysql` — `mysqlDialect`, `MysqlDialect`.
- `@dugstack/drizzle-migrator/sqlite` — `sqliteDialect`, `SqliteDialect`.

Dialect tokens carry database types into `createMigrator`; passing a mismatched database handle to
a bound migrator fails typechecking. Schema and tracking-table identifiers are validated through
the selected dialect during `createMigrator` construction.

New dialects implement the `DialectAdapter` interface (the entire seam: identifier quoting,
database name, locking, tracking-table bootstrap + drift assertion, version/log reads and
writes, transactions, raw execution) without touching the core.

## License

MIT — see [LICENSE](./LICENSE).
