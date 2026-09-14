---
name: drizzle-migrator-cli
description: Operating manual for @dugstack/drizzle-migrator-cli — how AI agents use the migrator executable to add, register, run, verify, and adopt Drizzle ORM migrations safely. Read this before touching any migration files.
---

# drizzle-migrator-cli — agent operating manual

The `migrator` executable (npm `@dugstack/drizzle-migrator-cli`) for the
`@dugstack/drizzle-migrator` core. The app owns a `drizzle-migrator.config.ts`, version folders,
and SQL files produced by `drizzle-kit generate`; the CLI discovers all of them and owns every
command, prompt, and the Postgres connection, while the core engine keeps the guarantees this
manual explains: forward-only history, atomic per-migration transactions, a surviving audit
trail, and compile-time-restricted SQL files.

Every name below (`migrations` schema, `migration_versions` / `migration_logs` tables) is a
package default — read the app's `migrator.config.ts` first and substitute its configured names.

## 1. Required context

Before touching migrations, read, in order:

1. the app's `migrator.config.ts` (sqlDir, migrationsDir, schema, table names, lockName, lock
   timings, logger);
2. the versions registry `<migrationsDir>/index.ts`;
3. the latest version folder `v<semver>/index.ts`;
4. the app's migration docs, if present.

## 2. Workflow (schema change, end to end)

1. Edit the app's drizzle schema and run `drizzle-kit generate` — generating SQL is the app's
   job; this package never writes SQL files.
2. Run the migrator CLI's `generate` command to scaffold `v<next>/index.ts` from the unapplied
   SQL files in `sqlDir`.
3. Register the entry: pass `--register`, or paste the printed snippet into the registry.
4. Run the app's typecheck.
5. Run `migrate` against a safe local database.
6. Run `migrate` again and confirm the output says `no pending migrations`.

## 3. Migration entry pattern

- One folder per version, named exactly `v<semver>` (e.g. `v0.0.7`), containing `index.ts`.
- The entry is a **named** export derived mechanically from the version: dots become
  underscores, so `version: "0.0.3"` must be exported as `migration_v0_0_3`. Never a default
  export.
- Registry imports are fully specified ESM paths:
  `import { migration_v0_0_3 } from "./v0.0.3/index.js";`
- Helper modules live inside their own version folder and are never imported across versions.
- `sqlFiles` is the compile-time allowlist: `ctx.runSqlFile` accepts only declared file names,
  and files resolve relative to `config.sqlDir`.

```ts
// app: src/db/migrator/versions/v0.0.3/index.ts
import { defineMigration } from "@dugstack/drizzle-migrator";

export const migration_v0_0_3 = defineMigration({
  version: "0.0.3",
  name: "add-games",
  sqlFiles: ["0003_games.sql"],
  async up(ctx) {
    await ctx.runSqlFile("0003_games.sql");
    await ctx.execute(`UPDATE "games" SET "slug" = lower("title")`);
  },
});
```

## 4. Breakpoints and data remaps

- SQL files are drizzle-kit output; statements are separated by `--> statement-breakpoint`.
- `runSqlFile(file, { from, to })`: `from` is inclusive (default 0), `to` is **exclusive**
  (default: through end of file). There is no `-1` sentinel — omit `to` to mean "end". Invalid
  ranges throw before anything executes.
- Data remap pattern — DDL part 1, raw backfill, DDL part 2, all inside the single migration
  transaction:

```ts
async up(ctx) {
  await ctx.runSqlFile("0007_users.sql", { to: 1 });   // CREATE TABLE users (email text)
  await ctx.execute(`UPDATE "users" SET "email" = lower("name")`);
  await ctx.runSqlFile("0007_users.sql", { from: 1 }); // ALTER COLUMN email SET NOT NULL
}
```

- Prefer raw SQL (`ctx.execute`) over the query builder for remaps — `ctx.tx` is the generic
  drizzle transaction handle.

## 5. Operational rules (never violate)

- Never edit an applied migration; add a new semver migration.
- Never change `lockName` after deployment.
- No network calls or file writes inside migrations; deterministic and retryable after failure.
- Avoid non-transactional statements (`CREATE INDEX CONCURRENTLY`) inside migrations — run them
  as a separate operational step.
- Never run migrations from application startup; deployment commands only.
- Migrator tracking tables must never be added to the app's drizzle-kit schema input (the
  drift-assertion guard exists precisely because those two definitions must be edited together).
- pg: run against a single dedicated connection (a `pg.Client`, not a shared `Pool`) — the
  advisory lock is session-scoped, so acquire, migrate, and release must share one connection.

## 6. Adoption rules

- `adopt` never executes migration SQL; it records rows with `origin: 'adopted'`.
- Requires `--confirm-database=<name>` matching the connected database — a stale `DATABASE_URL`
  must never adopt the wrong database.
- Refuses when the `CI` env var is set — adoption is a manual, one-time step.
- Refuses a database with no tables in its default schema (a real `migrate` is wanted).
- Without `--force`, aborts when the versions table already has rows.
- With `--force`, the effective range starts **above the highest recorded version** and runs
  through `--to`. Never widen a range to silence a pending migration.

## 7. Verification SQL

Defaults shown; substitute the configured schema/table names.

Current version:

```sql
SELECT version, name, origin, applied_at
FROM "migrations"."migration_versions"
ORDER BY applied_at DESC
LIMIT 1;
```

Recent audit entries:

```sql
SELECT at, kind, version, detail
FROM "migrations"."migration_logs"
ORDER BY at DESC
LIMIT 20;
```

Stuck runs (the migrator process died mid-flight — `run.started` with no matching
`run.applied`/`run.failed` for the same run_id + version):

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

## 8. Command table

| command | flags |
| --- | --- |
| `migrate` | `--dry-run` |
| `adopt` | `--from= --to= --force --confirm-database=` |
| `status` | `--json` |
| `generate` | `--version= --name= --yes --register` |
| `validate` | – |

This table is test-diffed against the CLI's command table (`src/commands.ts`, the single source
of truth) — never edit one side without the other; a mismatch fails CI.
