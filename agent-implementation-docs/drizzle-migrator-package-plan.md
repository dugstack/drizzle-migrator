# PLAN: `@dugstack/drizzle-migrator`

> **Scope notice.** The npm scope for this package is `@dugstack` (decided). It appears in code
> samples, docs, and test fixtures throughout this plan.

A standalone, config-driven database migration orchestrator for [Drizzle ORM](https://orm.drizzle.team)
projects. The drizzle client is injected by the consumer. Dialect-specific behavior (tracking
tables, locking, identifiers) lives behind subpath exports: `/pg`, `/mysql`, `/sqlite`.

This document is written so it can be dropped into an empty repository and implemented by an AI
agent or developer with no other context. It includes full API specs, database schemas, command
behavior, testing requirements, and acceptance criteria.

---

## 1. Why this package exists

Drizzle's built-in `migrate()` has gaps that every real project eventually hits:

- It tracks migrations by **hash of the SQL file** — editing an applied file breaks integrity checks.
- It has **no story for data remaps** interleaved with generated DDL (the classic
  "add nullable column, backfill, then add NOT NULL" flow).
- It has **no audit trail** — when a migration fails at 3am you cannot answer "what was attempted,
  when, and what was the error" from the database.
- It has **no safe way to adopt an existing database** (a database built by other means must be
  recorded as already-migrated without executing anything — a step that fails silently if done wrong).

This package is a TypeScript migration orchestrator on top of drizzle-generated SQL with:

1. **Semver versions** (`v0.0.3/`) as the unit of migration, sorted numerically (so `0.10.0 > 0.9.0`).
2. **Per-migration transactions** — the version row is committed *inside* the migration transaction:
   applied-and-recorded, or neither.
3. **Typed SQL files** — each migration declares the SQL files it uses; `ctx.runSqlFile` accepts
   only those names at compile time.
4. **An event audit log** — every migrator lifecycle event plus app events appended from inside
   migrations.
5. **A guarded `adopt` command** for existing databases.
6. **`status`, `dry-run`, and `generate` commands** for day-to-day operation.
7. **Config-driven everything** — one project config file; no set-in-stone names or paths.
8. **A bundled agent skill** — the package ships a `SKILL.md` so AI agents work with it correctly
   out of the box (§15). Treated as public API, not documentation garnish.

**This document is fully self-contained.** Every behavior, schema, guard, and API an implementer
needs is specified below; no external repository or files are required. (Provenance only: the
design was battle-tested in a production monorepo whose hardcoded app-specific values — lock name,
schema, log prefix — have been extracted into config for this package.)

---

## 2. Non-goals (v1)

- **No `down()` migrations.** Forward-only is a deliberate, documented stance. Rollback is
  handled by adding a new semver migration.
- **No MySQL/SQLite implementations in v1.** The adapter interface ships, `/pg` ships, `/mysql`
  and `/sqlite` ship as stubs that throw a clear "not implemented yet" error. (See §11.)
- **No drizzle-kit integration.** `drizzle-kit generate` remains the app's job. `generate` only
  scaffolds migration entries from SQL files already on disk.
- **No config-file loader magic.** The config is a normal TS module the app imports into its own
  bin script (§6). No `process.cwd()` scanning, no bundler loaders.
- **No migrations from app startup.** Migration runs are deployment-time commands, never side
  effects of booting an API server.
- **No website in v1.** The `apps/docs` workspace slot is reserved and scaffolded (empty, private,
  Astro + Starlight designated) so the "website ASAP if the package gets popular" flip needs no
  restructuring — but v1 ships no website.

---

## 3. Repository and package layout

Single **published** npm package with **subpath exports** (decided): one version line, one install,
dialect code tree-shakeable and behind subpaths. The repo hosting it is a **pnpm-workspace
monorepo** (decided — see Repo shape below), with a reserved slot for a future docs website.

```
drizzle-migrator/                  # repo root — private, never published
  pnpm-workspace.yaml
  package.json                     # private root: shared scripts + devDeps, changesets
  biome.json                       # lint + format (single tool, keep it simple)
  .github/workflows/
    ci.yml                         # path-filtered: lib CI only on packages/core/**
    release.yml                    # changesets version + npm publish --provenance
  apps/
    docs/                          # RESERVED workspace slot — not built in v1 (§2).
      package.json                 # Private. Name: "@dugstack/drizzle-migrator-docs"
                                   # (same @dugstack scope as the lib).
                                   # When built: Astro + Starlight. Exists so the "website ASAP"
                                   # flip is scaffolding, not restructuring.
  packages/
    drizzle-migrator/              # THE published package — everything below lives here
      package.json                 # @dugstack/drizzle-migrator (essentials below)
      tsconfig.json
      vitest.config.ts
      src/
        core/                      # dialect-agnostic engine — no pg imports allowed
          index.ts                 # public factory, migration/config definitions, public types
          migrator.ts              # createMigrator factory + Migrator service interface
          engine.ts                # runMigrations / adoptMigrations / getStatus orchestration
          migration.ts             # defineMigration + Migration/MigrationContext types
          registry.ts              # sort + validate (versions, sqlFiles uniqueness, file existence)
          sql.ts                   # statement-breakpoint splitting + range logic
          config.ts                # MigratorConfig type + defineConfig validation
          adapter.ts               # DialectAdapter interface (the dialect seam)
          audit.ts                 # audit event kinds + payload types
          generate.ts              # prompt-free entry generation + suggestion defaults
          result.ts                # RunMigrationsResult / AdoptResult / StatusReport types
        pg/                        # v1 reference dialect
          index.ts                 # exports only the pgDialect token
          adapter.ts               # DialectAdapter implementation for node-postgres
          bootstrap.ts             # tracking-table DDL + drift assertion
          tables.ts                # drizzle pg-core definitions of tracking tables
        mysql/
          index.ts                 # token; every adapter method throws at first use
        sqlite/
          index.ts                 # token; every adapter method throws at first use
      test/
        engine.test.ts             # core engine against a fake in-memory adapter
        pg.integration.test.ts     # testcontainers postgres
        config.test.ts
        migrator.test.ts           # factory surface + service methods (validation audits, suggestion, appendAuditEvent)
        generate.test.ts
        types.test.ts              # expectTypeOf guards for the typed sqlFiles contract
    drizzle-migrator-cli/          # the executable — sole CLI owner (Revision 3): command table,
                                   # dispatch, flag parsing, prompts, usage, skills, pg wiring
      package.json                 # @dugstack/drizzle-migrator-cli; bin: migrator -> ./dist/bin.js
      skills/
        drizzle-migrator/         # bundled agent skill — a first-class, shipped artifact (see §15)
          SKILL.md
      src/
        commands.ts               # THE single command table: names, flags, requiresDatabase,
                                  # descriptions; dispatch, flag validation, usage, and the
                                  # README/skill sync tests all consume this one definition
        config.ts                 # dialect-discriminated CLI config + validation ("postgres" member;
                                  # postgres block optional — database commands fail without it)
        discovery.ts              # config-file discovery + v<semver>/index.ts auto-discovery
        drizzle-out.ts             # sqlDir resolution: drizzleOutDir > drizzle.config out > "./drizzle"
        loader.ts                  # jiti-based TypeScript module loader (configs + entries)
        connect.ts                 # pg.Client -> drizzle(client) wiring (one dedicated client per command)
        prompts.ts                 # readline prompting for generate (the core never prompts)
        usage.ts                   # usage rendering from the single command table
        run.ts                     # runCli: global flags, command parsing, dispatch, output, exit codes
        bin.ts                     # #!/usr/bin/env node executable entry
      test/
        config.test.ts             # postgres-block optionality + connection-string validation
        discovery.test.ts          # folder-naming validation + config path discovery
        drizzle-out.test.ts        # manual vs drizzle-derived SQL directory
        run.test.ts                # global flags + CLI-owned dispatch per command
        usage.test.ts              # usage rendering covers every command/flag in the table
        skill-sync.test.ts         # SKILL.md command/flag table matches the CLI command table
        pg.integration.test.ts     # full testcontainers path (migrate / status / generate / validate)
```

### `package.json` essentials (lives at `packages/core/package.json`)

```jsonc
{
  "name": "@dugstack/drizzle-migrator",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "exports": {
    ".": { "types": "./dist/core/index.d.ts", "import": "./dist/core/index.js" },
    "./pg": { "types": "./dist/pg/index.d.ts", "import": "./dist/pg/index.js" },
    "./mysql": { "types": "./dist/mysql/index.d.ts", "import": "./dist/mysql/index.js" },
    "./sqlite": { "types": "./dist/sqlite/index.d.ts", "import": "./dist/sqlite/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:integration": "vitest run --dir test --include 'pg.integration.test.ts'",
    "lint": "biome check .",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "drizzle-orm": "0.45.2",
    "pg": ">=8.0.0"
  },
  "peerDependenciesMeta": { "pg": { "optional": true } },
  "devDependencies": {
    "tsup": "^8", "typescript": "^5.7", "vitest": "^3",
    "@testcontainers/postgresql": "^10", "drizzle-orm": "0.45.2", "pg": "^8", "@types/pg": "^8"
  }
}
```

Rules:

- **Zero runtime dependencies.** Everything is `drizzle-orm` + node builtins. The CLI package
  parses argv by hand and prompts via `node:readline/promises` — do not add
  commander/inquirer/etc. (to either package).
- Build with **tsup** (ESM output only, `dts: true`, per-entry files so subpaths resolve).
- `drizzle-orm` and `pg` are **peer dependencies only**. CI must run the integration suite against
  a matrix of at least two drizzle-orm minor versions to prove the peer range.
- Publish with `npm publish --access public --provenance` **from `packages/core`
  only**. Versioning via **changesets** at the repo root.

**Repo shape (decided): a pnpm-workspace monorepo from day one.** Rationale: a docs website is
anticipated to be needed ASAP if the package gains traction, and restructuring a popular repo
mid-life is riskier than reserving the slot now. Rules:

- The root is private tooling only — it never publishes. The published units are
  `packages/core` (one version line, subpath exports) and, since Revision 2, its
  companion executable `packages/cli` (§7 "CLI package"); the core remains the
  single source of engine semantics.
- `apps/docs/` exists as a **reserved, empty workspace** in v1 (see §2): only a minimal private
  `package.json`. When the website is built, it lands there as **Astro + Starlight** reading the
  README/plan content — no restructuring, no moves, instant flip.
- Do **not** add turborepo/nx for two workspaces; plain pnpm scripts suffice. Revisit only if
  more heavy units appear.
- CI is path-filtered: lib build/test/publish triggers only on `packages/core/**`
  and workflow files, so website work never gates the package.
- Future dialect packages (if ever versioned independently) would join as sibling `packages/*` —
  the adapter seam (§9) already allows it. Until then, dialects stay subpaths of the one package.

---

## 4. Core concepts and data model

### 4.1 Migration entries (app-side, folder-per-version)

Migrations live in the app as **one folder per version**, registered in an app-owned array.
The package never auto-discovers files.

```
app/src/db/migrator/versions/
  index.ts            # the registry — explicit, statically imported (see below)
  v0.0.1/
    index.ts          # the migration entry (named-export defineMigration({...}); see below)
  v0.0.2/
    index.ts
  v0.1.0/
    index.ts
    backfill.ts       # helper modules live beside the entry, inside the version folder
```

**Folder layout rules:**

- Every version is a folder named exactly `v<semver>` (e.g. `v0.0.3`) containing `index.ts`, which
  exports a **named** `defineMigration({...})` — never a default export. Helper modules live in
  the same folder. Helper files must not be imported across version folders — a version folder is
  self-contained.
- **Canonical export name (decided): `migration_v<major>_<minor>_<patch>`**, derived mechanically
  from the version (dots → underscores). This pins the export identity so nobody can "name the
  version anything": `version: "0.0.3"` must be exported as `migration_v0_0_3`. Note honestly:
  export *names* don't survive module loading, so this cannot be runtime-validated by the engine.
  Enforcement is: `generate` always emits the canonical name, `--register` always imports it, the
  package's own test suite regex-checks generated sources, and the convention is documented here
  and in the skill.
- The folder name is enforced, not cosmetic: the registry validator rejects any entry whose folder
  name is not exactly `v` + the `version` field (e.g. folder `v0.0.2` with `version: "0.0.9"` is a
  hard error). One source of truth, no drift.
- Why the `v` prefix (decided): research found **zero documented failures** for digit-leading or
  dot-containing folder names across Linux/macOS/Windows and the Node/TS/webpack/vite toolchain —
  specifiers are quoted strings, semver folders never start with a dot (so no hidden-file
  behavior), and never end with one (the only genuinely dangerous dot case on Windows is a
  *trailing* dot). The `v` prefix is belt-and-suspenders: it aligns with git-tag/Docker/Go-module
  conventions and immunizes against any tool that treats leading-digit paths specially, at the
  cost of one enforced mapping (`folder === "v" + version`).
- **Registry imports must be fully specified ESM paths**: `import v001 from "./v0.0.1/index.js"`.
  Node ESM requires directory indexes to be fully specified (`./v0.0.1` alone throws
  `Unsupported Directory Import`); `generate --register` emits exactly this form.

```ts
// app: src/db/migrator/versions/v0.0.3/index.ts
import { defineMigration } from "@dugstack/drizzle-migrator";

export const migration_v0_0_3 = defineMigration({
  version: "0.0.3",
  name: "add-games",
  // Declared here. This literal list is the compile-time type of runSqlFile's
  // `file` parameter. Files are resolved relative to config.sqlDir.
  sqlFiles: ["0003_games.sql"],
  async up(ctx) {
    await ctx.runSqlFile("0003_games.sql", { to: 2 });   // OK
    await ctx.runSqlFile("0003_games.sql", { from: 2 }); // OK (to omitted = through end)
    await ctx.runSqlFile("0004_users.sql");              // COMPILE ERROR: not declared
    await ctx.execute(`UPDATE "games" SET "slug" = lower("title")`); // raw SQL inside the tx
  },
});
```

```ts
// app: src/db/migrator/versions/index.ts — the registry
import { migration_v0_0_1 } from "./v0.0.1/index.js";
import { migration_v0_0_2 } from "./v0.0.2/index.js";
import { migration_v0_0_3 } from "./v0.0.3/index.js";

export const migrations = [migration_v0_0_1, migration_v0_0_2, migration_v0_0_3];
```

**Type-level contract (must be locked with `expectTypeOf` tests):**

- `defineMigration<const TFiles extends readonly string[]>(migration)` uses a **const type
  parameter** (TS 5.0+) so literal types are inferred from the `sqlFiles` array literal *without*
  requiring `as const` at every call site.
- `MigrationContext<TFiles>` exposes `runSqlFile(file: TFiles[number], range?: RunSqlFileRange)`.
- If `sqlFiles` is omitted, `runSqlFile` accepts `never` — running a file requires declaring it.
- `ctx.tx` is the drizzle transaction handle; `ctx.execute(rawSql)` runs one raw statement.

**Registry-level validation (runtime, before anything executes):**

- Every `version` matches `/^\d+\.\d+\.\d+$/`.
- No duplicate versions.
- Every entry's folder name is exactly `v` + `version`; flat `<version>.ts` files are rejected —
  the layout is uniformly folder-per-version.
- **No SQL file may be declared by two different migrations** — a file is applied exactly once.
  Duplicate usage across entries is a hard error listing the clashing versions.
- Every declared `sqlFiles` entry must exist on disk under `config.sqlDir` (fail-fast `fs.stat`).
- The registry is sorted numerically by semver; input order is irrelevant.

### 4.2 SQL files and statement breakpoints

- SQL files are drizzle-kit output, statements separated by `--> statement-breakpoint`.
- `runSqlFile(file, { from?, to? })`: `from` inclusive (default 0), `to` **exclusive** (default:
  through end of file). There is **no `-1` sentinel** in this package — omitting `to` means "end".
  Invalid ranges (`from < 0`, `to < from`, `to > statement count`) throw before executing anything.
- Empty statements (after trim) are skipped.
- Each statement runs individually on the transaction (`sql.raw`), so a mid-file failure rolls back
  the whole migration transaction.

### 4.3 Tracking tables (created by the migrator, never by drizzle-kit)

All names come from config (§6). Postgres defaults shown; the DDL lives in the dialect adapter and
every statement is `IF NOT EXISTS` (idempotent, runs on every invocation):

```sql
CREATE SCHEMA IF NOT EXISTS "migrations";  -- pg only; name from config.schema

CREATE TABLE IF NOT EXISTS "migrations"."migration_versions" (
  "version"    text PRIMARY KEY NOT NULL,
  "name"       text NOT NULL,
  "origin"     text NOT NULL DEFAULT 'executed',  -- 'executed' | 'adopted'
  "applied_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "migrations"."migration_logs" (
  "id"         uuid PRIMARY KEY NOT NULL,
  "at"         timestamptz DEFAULT now() NOT NULL,
  "kind"       text NOT NULL,
  "version"    text,              -- set for version-scoped entries
  "run_id"     uuid,              -- groups entries belonging to one CLI invocation
  "payload"    jsonb,             -- structured detail; must be JSON-serializable
  "detail"     text               -- human-readable line (error stacks go here)
);
CREATE INDEX IF NOT EXISTS "migration_logs_kind_idx" ON "migrations"."migration_logs" ("kind");
CREATE INDEX IF NOT EXISTS "migration_logs_version_idx" ON "migrations"."migration_logs" ("version");
```

- The `origin: 'adopted'` column is how the database records "this version was adopted, never
  executed" (instead of a separate "baselined" status in a runs table).
- The single **log table** (`migration_logs`) is the migrator's entire audit surface. A migration attempt is
  reconstructed as: event `run.started` with no matching `run.applied` /
  `run.failed` for the same `run_id` + version ⇒ the migrator process died mid-flight.

### 4.4 Audit event kinds

Emitted by the engine automatically:

| kind | version | payload/detail |
| --- | --- | --- |
| `cli.command` | – | `{ command, flags }` (argv echo, redacted) |
| `validation.started` | – | written by `validateMigrationEntries({ db })` before validating |
| `validation.completed` | – | `{ status: "passed", migrations }` — written only on success |
| `validation.failed` | – | `{ status: "failed" }`, `detail` = the joined validation errors |
| `lock.acquired` / `lock.waiting` / `lock.released` / `lock.timeout` | – | wait durations |
| `bootstrap.completed` | – | tracking schema/table names |
| `run.started` | ✓ | `{ name, runId }` |
| `run.applied` | ✓ | `{ name, runId, durationMs }` |
| `run.failed` | ✓ | `{ name, runId }`, `detail` = error stack |
| `run.adopted` | ✓ | `{ name, origin: 'adopted' }` |
| `dryrun.completed` | – | `{ pending: string[] }` |

- `run.started` is written inside the migration transaction? **No** — deliberately written *outside*
  the transaction so it survives rollbacks; same for `run.failed` and `run.adopted`.
- The audit log must never mask the real error: event-write failures are logged, never thrown.
- The `validation.*` events are written by `validateMigrationEntries` only when a `db` is
  supplied; their write failures are ignored entirely and never replace the validation result or
  its errors.

**Public append API** (decided): inside migrations,

```ts
ctx.audit("backfill.progress", { rows: 1234 });
```

`ctx.audit` writes **inside** the migration transaction (rolls back with it — appropriate for
progress notes tied to the migration's outcome). The engine-level events above are written outside
transactions so they survive failures. Document this distinction in the README.

### 4.5 Locking (per dialect; pg in v1)

- **Postgres:** session-scoped advisory lock, `pg_try_advisory_lock(hashtext(lockName))` in a
  retry loop (`lock.waitTimeoutMs` default 10 min, `lock.retryIntervalMs` default 5s), released in
  a `finally`. `lockName` is **required** config, must be unique per application, and must never
  change after first deployment (changing it allows two deploy processes to migrate concurrently).
- The lock is held on **one checked-out client** for the whole run (session-scoped semantics).
  The docs must warn: pass a single client / a pool you own, and do not share it.
- MySQL (future): `GET_LOCK`/`RELEASE_LOCK`. SQLite (future): no server-side lock — document
  single-migrator-process assumption and run in `BEGIN IMMEDIATE`.

---

## 5. Engine behavior

`runMigrations` programmatic flow (fully specified here — implement exactly this):

1. Validate the registry (§4.1) — including sqlFiles existence on disk. Fail before touching the DB.
2. Acquire the dialect lock (retry loop, timeout error on exhaustion).
3. Bootstrap tracking tables (idempotent DDL) + **drift assertion**: after the DDL runs, query the
   catalog (`information_schema.columns` filtered to the tracking schema), build a map of table
   name → set of column names, and compare each tracking table's physical columns against the
   columns declared in the adapter's drizzle table definitions (`getTableConfig` from
   `drizzle-orm/pg-core`). On any mismatch throw an error naming the tracking table and listing
   both the missing and the undeclared columns. This guard exists because the DDL and the drizzle
   definitions are two representations of the same tables — editing one without the other would
   otherwise be a silent no-op that only surfaces as a missing-column error mid-migration.
4. Read applied versions; log current version + pending list.
5. For each pending migration in semver order:
   - `dry-run` mode: print the statements that would run (file, range, statement preview) and skip
     execution entirely. No version rows, no audit events beyond `dryrun.completed`.
   - Normal mode: insert `run.started`; open a transaction; build `MigrationContext` (tx, execute,
     runSqlFile, audit); run `up(ctx)`; insert the version row (`origin: 'executed'`) **inside the
     same transaction**; commit. On success insert `run.applied`. On failure the transaction rolls
     back, `run.failed` is appended outside the tx, and the error rethrows.
6. Release the lock. Return a result object:

```ts
type RunMigrationsResult = {
  applied: string[];   // versions executed this run
  skipped: string[];   // already applied
  dryRun: string[];    // pending versions that would run (dry-run mode only)
};
```

### `adoptMigrations` (the new `adopt` command)

Replaces the older "baseline" concept. **Never executes any SQL.** Records version
rows with `origin: 'adopted'` plus `run.adopted` audit events.

```ts
await adoptMigrations({
  db, config, migrations,
  from?: string,   // default: first migration in the registry
  to?: string,     // default: last migration in the registry
  force?: boolean, // default: false
});
```

Behavior (user-specified, follow exactly):

- Range is `[from ?? first, to ?? last]`, inclusive, validated against the registry — an unknown
  `from`/`to` aborts with the registry listed.
- If the versions table already has rows:
  - **without `force`**: abort, change nothing. Message explains `--force`.
  - **with `force`**: the effective range starts **above the highest recorded version** and runs
    through `to`. If `to` is not above the highest recorded version, there is nothing to adopt:
    exit cleanly with a message.
- Guard rails:
  - Requires `--confirm-database=<name>` matching `current_database()` (a stale `DATABASE_URL`
    must never adopt the wrong database). *(Flagged as a possible relaxation — see §13.)*
  - Refuses when `CI` env var is set — adoption is a manual, one-time step.
  - Refuses when the target database has **no tables** in its default schema — there is no
    schema to adopt; a real `migrate` is wanted.
- Returns `{ adopted: string[]; notAdopted: string[] }` (`notAdopted` = registry versions above `to`).

### `getStatus`

Reads only; returns:

```ts
type StatusReport = {
  currentVersion: string | null;
  applied: { version: string; name: string; origin: "executed" | "adopted"; appliedAt: string }[];
  pending: { version: string; name: string }[];
  recentLogs: { at: string; kind: string; version: string | null; detail: string | null }[];
};
```

The `status` CLI command prints this human-readable, or `--json`.

---

## 6. Project config file (the one place)

A normal TS module owned by the consuming app, imported by its bin script:

```ts
// app: src/db/migrator.config.ts
import { defineConfig } from "@dugstack/drizzle-migrator";

export const migratorConfig = defineConfig({
  sqlDir: "./drizzle",            // drizzle-kit SQL output folder (default "./drizzle")
  migrationsDir: "./src/db/migrator/versions", // migration entry files (default "./migrations")
  schema: "migrations",           // pg: tracking schema (default "migrations")
  tables: {
    versions: "migration_versions", // default
    logs: "migration_logs",         // default
  },
  lockName: "myapp:db:migrations",  // REQUIRED. Unique per app. Never change after deploy.
  lock: { waitTimeoutMs: 600_000, retryIntervalMs: 5_000 }, // optional overrides
  logger: console,                  // optional; anything with info/error
});
```

- `defineConfig` validates path sanity, required `lockName`, lock timings, and logger shape.
  Schema and table identifiers are validated at `createMigrator` time through the selected
  dialect's `quoteIdentifier`, so dialect-specific rules fail fast with the offending identifier.
- Every runtime path (sqlDir, migrationsDir, schema, table names, lock key, timeouts, logger) is
  config — **nothing is set in stone** except the event/origin vocabulary itself.
- Relative paths resolve from `process.cwd()` at call time (the bin script's working directory).

---

## 7. Public API surface

### `@dugstack/drizzle-migrator` (core, dialect-free)

```ts
createMigrator<D extends DialectAdapter<any, any>>(options: {
  dialect: D;
  config: MigratorConfig;
  migrations: Migration[];
}): D extends DialectAdapter<infer TDb, infer TTx> ? Migrator<TDb, TTx> : never;

defineMigration<TFiles extends readonly string[]>(migration: MigrationInput<TFiles>): Migration<TFiles>;
defineConfig(config: MigratorConfigInput): MigratorConfig;
// types: Migrator, Migration, MigrationContext<TFiles>, RunSqlFileRange, MigratorConfig,
//        RunMigrationsResult, AdoptResult, StatusReport, GenerateResult,
//        MigrationEntrySuggestion, MigrationEntriesValidationResult, ValidationAuditOptions,
//        MigratorLogger, AuditLogEntry
```

`Migrator<TDb, TTx>` binds dialect, config, and migrations at construction. Public service
methods: `runMigrations({ db, dryRun? })`,
`adoptMigrations({ db, from?, to?, force?, confirmDatabase })`, `getStatus({ db })`,
`validateMigrationEntries({ db? }?)` (connection-free without `db`; with `db`, writes
`validation.started` then `validation.completed`/`validation.failed`, ignoring audit-write
failures), `suggestMigrationEntry()` (next patch version + `pending-migration`),
`generateMigrationEntry({ version, name, register? })` (no prompting, no `yes`; version and name
must be resolved), and `appendAuditEvent({ db, entry })` (binds the configured audit storage to a
supplied compatible handle — the CLI's door for redacted `cli.command` events, available equally
to custom CLIs). The core never parses argv, prints output, sets exit codes, reads stdin, or
opens connections; engine functions remain internal. A database handle incompatible with the
selected dialect fails typechecking.

### Dialect subpaths

```ts
@dugstack/drizzle-migrator/pg: pgDialect, PgDialect
@dugstack/drizzle-migrator/mysql: mysqlDialect, MysqlDialect
@dugstack/drizzle-migrator/sqlite: sqliteDialect, SqliteDialect
```

Each dialect subpath exports only its adapter token and type. MySQL and SQLite tokens throw
`"<id> adapter is not implemented in v1"` when any adapter method runs, never on import.

Database handles are command-specific: each call opens and closes its own client — critical for
the session-scoped advisory lock: acquire, migrate, and release must share **one** connection, so
the engine must hold a single checked-out client for the whole run, never letting queries
round-robin over a pool.

### CLI commands (owned by the CLI package)

| command | flags | notes |
| --- | --- | --- |
| `migrate` | `--dry-run` | the only command a deploy pipeline runs; requires a database |
| `adopt` | `--from= --to= --force --confirm-database=` | §5; requires a database |
| `status` | `--json` | read-only; requires a database |
| `generate` | `--version= --name= --yes --register` | §8; connection-free |
| `validate` | – | registry lint: versions, duplicate versions, duplicate sqlFiles, file existence; exit 1 with reasons; connection-free without a configured connection string |

The table is defined once inside the CLI package (`src/commands.ts`, with a `requiresDatabase`
marker per command) and drives command dispatch, flag validation, usage rendering, and the
README/skill sync tests.

### CLI package (`@dugstack/drizzle-migrator-cli`)

The companion executable is the **sole CLI owner** (Revision 3): it defines the command table,
parses argv, validates flags, prompts, renders output, maps errors to exit codes, and owns the
Postgres connection lifecycle. The core programmatic API (`createMigrator({ dialect, config,
migrations })` and the `Migrator` service methods) is unchanged. The CLI:

- discovers `drizzle-migrator.config.{ts,mts,cts,js,mjs,cjs}` in the cwd (`--config <path>`
  overrides), loads it and the migration entries through **jiti** — configs and entries stay
  normal TypeScript — and validates it through a `dialect`-discriminated config:

  ```ts
  export default defineConfig({
    dialect: "postgres",
    // optional since Revision 3: generate/validate run without it; migrate/adopt/status
    // fail before any connection attempt when it is absent
    postgres: { connectionString: process.env.DATABASE_URL! },
    migratorOutDir: "./src/db/migrator",  // required; scanned for v<semver>/index.ts
    drizzleOutDir: "./drizzle",           // optional; wins over the drizzle config's out
    lockName: "myapp:migrator",           // optional; default "drizzle-migrator"
  });
  ```

- resolves the SQL directory: `drizzleOutDir` → drizzle.config `out` → `"./drizzle"`;
- auto-discovers migrations as `<migratorOutDir>/v<semver>/index.ts` — one migration export per
  folder, folder name exactly `"v" + version`, unique versions, numeric sort — **no manual
  registry file**;
- owns the pg connection wiring (`pg.Client` → `drizzle(client)` → `pgDialect` →
  `createMigrator`), one dedicated session-scoped client per command, closed in `finally` blocks;
- fails `migrate`/`adopt`/`status` before any connection attempt when the Postgres
  configuration is absent; `generate` and `validate` remain connection-free (`validate` opens one
  dedicated connection only when a connection string is configured, passing it to
  `validateMigrationEntries` for the audit trail);
- prompts for `generate` (via `node:readline/promises`) when `--yes` is absent, using the core's
  `suggestMigrationEntry()` defaults, then calls `generateMigrationEntry` with explicit values;
- appends redacted `cli.command` audit events through the public `appendAuditEvent` service
  method — custom CLIs receive equal access.

---

## 8. The `generate` command (user-specified behavior)

`config` and `migrations` come from the constructed `Migrator`; callers supply only generation
options. Since Revision 3 the core performs **no prompting**: `generateMigrationEntry` requires
resolved `version` and `name` values, and `suggestMigrationEntry()` exposes the domain defaults.

1. Scan `config.sqlDir` for top-level `*.sql` files (ignore `meta/`, journals, snapshots).
2. "Unapplied" = present on disk but not referenced by any registered migration's `sqlFiles`.
3. Defaults (owned by `suggestMigrationEntry()`): next **patch** version above the highest
   registered version (`0.0.6` → `0.0.7`; empty registry → `0.0.1`), and kebab-case name default
   `pending-migration`.
4. **The CLI prompts** (via `node:readline/promises`) when `--yes` is absent, showing the
   suggested defaults; empty input accepts the default. `--version`/`--name` skip prompts
   individually; `--yes` **skips all prompts and uses every default** (alias `-y`). The CLI then
   calls `generateMigrationEntry` with the resolved explicit values.
5. The core validates the resolved `version` (`\d+.\d+.\d+`) and `name` (kebab-case) shapes
   before writing anything.
6. Write `<migrationsDir>/v<version>/index.ts` (folder-per-version, per §4.1):

```ts
// app: src/db/migrator/versions/v0.0.7/index.ts
import { defineMigration } from "@dugstack/drizzle-migrator";

export const migration_v0_0_7 = defineMigration({
  version: "0.0.7",
  name: "pending-migration",
  sqlFiles: ["0007_new_tables.sql", "0008_more.sql"], // every unapplied file, sorted
  async up(ctx) {
    await ctx.runSqlFile("0007_new_tables.sql");
    await ctx.runSqlFile("0008_more.sql");
  },
});
```

7. With `--register`, append the import + array entry to `<migrationsDir>/index.ts` if that file
   exists and matches a recognizable pattern; otherwise print the exact snippet to paste. Without
   it, always print the snippet. The emitted import must use the canonical export name and a
   fully specified ESM path:

   ```ts
   import { migration_v0_0_7 } from "./v0.0.7/index.js";
   ```
8. Never overwrites an existing entry — a version whose folder `v<version>/` already exists is an
   error.

```ts
type GenerateResult = {
  version: string;      // the scaffolded version, e.g. "0.0.7"
  name: string;         // the migration name used
  entryPath: string;    // path to the written entry, e.g. "<migrationsDir>/v0.0.7/index.ts"
  sqlFiles: string[];   // the unapplied files the entry declares
  registered: boolean;  // true: appended to <migrationsDir>/index.ts; false: snippet printed only
};
```

---

## 9. Dialect adapter seam (the contract `/pg` implements)

```ts
export interface DialectAdapter<TDb = unknown, TTx = unknown> {
  readonly id: "pg" | "mysql" | "sqlite";

  quoteIdentifier(identifier: string): string; // validates shape, throws on anything odd
  currentDatabaseName(db: TDb): Promise<string | null>;

  acquireLock(db: TDb, lockName: string, opts: { waitTimeoutMs: number; retryIntervalMs: number }): Promise<void>;
  releaseLock(db: TDb, lockName: string): Promise<void>;

  bootstrapTrackingTables(db: TDb, config: ResolvedConfig): Promise<void>; // idempotent DDL + drift assert
  readAppliedVersions(db: TDb, config: ResolvedConfig): Promise<Set<string>>;
  recordVersion(db: TDb, config: ResolvedConfig, entry: { version: string; name: string; origin: "executed" | "adopted" }): Promise<void>;
  appendLog(db: TDb, config: ResolvedConfig, entry: AuditLogEntry): Promise<void>;

  runInTransaction(db: TDb, fn: (tx: TTx) => Promise<void>): Promise<void>;
  executeRaw(tx: TTx, statement: string): Promise<void>;
}
```

The core engine (`src/core/engine.ts`) is written entirely against this interface and is tested
through `createMigrator` with an **in-memory fake adapter** (no database) plus the real pg adapter
in integration tests. Dialect subpaths export exactly one value: adapter token plus its type.
MySQL and SQLite stub tokens throw at first adapter-method use, never on import.

`/pg` specifics:

- Works with `drizzle-orm/node-postgres`. `db.execute` returns `{ rows }` — normalize inside the
  adapter; the core never touches result shapes.
- Drift assertion per §5, using `getTableConfig` from `drizzle-orm/pg-core` on the drizzle side.
- `quoteIdentifier` validates against `/^[a-z_][a-z0-9_]*$/` and wraps the value in double quotes;
  any other shape throws immediately (it guards the raw DDL interpolation in bootstrap, so an
  invalid config identifier fails loudly instead of producing broken SQL).

---

## 10. Testing requirements (the credibility of the package)

Integration tests run against **real Postgres via testcontainers** (`@testcontainers/postgresql`).
pg-mem is not acceptable (no advisory locks, no `hashtext`).

Engine (fake adapter, fast):

- Semver numeric ordering (`0.10.0` after `0.9.0`), duplicate version rejection.
- Duplicate sqlFiles across migrations rejected; missing sqlFiles on disk rejected.
- Typed sqlFiles contract (`expectTypeOf`: wrong file name is a type error; omitted `sqlFiles`
  makes `runSqlFile` accept `never`).
- Breakpoint range math incl. invalid ranges.
- Failure mid-migration ⇒ version row absent (rolled back), `run.failed` event present.
- `--force` adopt arithmetic over an existing versions table.

pg integration (testcontainers):

- Happy path: two migrations apply, versions recorded `origin: 'executed'`, second run reports
  `no pending migrations` and is a no-op.
- Concurrency: two migrators against one DB — the second waits for the lock, re-reads, exits clean.
- Killed migrator (simulate by inserting `run.started` and aborting): `status` surfaces it.
- Data-remap flow with breakpoints: DDL part 1 → raw backfill → DDL part 2, all in one transaction.
- Adopt guards: unknown version, wrong `--confirm-database`, empty schema, existing rows without
  `--force`, `CI` env refusal; then the `--force` continuation path.
- Bootstrap drift assertion fails when a column is added to one side only.
- `generate`: scaffold folder + entry content (`v<version>/index.ts`), canonical export name
  (`migration_v<major>_<minor>_<patch>`), `--yes` defaults, version collision error,
  unapplied-file scan (including ignoring `meta/`), and a `--register` snippet that emits the
  canonical named import with a fully specified ESM path (`./v<version>/index.js`).
- Folder layout: folder-name !== `v` + version is rejected; a flat `<version>.ts` file is
  rejected; helper files inside a version folder are accepted.
- Skill sync (CLI package): the bundled `SKILL.md`'s command and flag table matches the CLI's
  single command table (parse both and diff — the skill drifting from the CLI is a bug), and no
  undocumented or stale flag may appear anywhere in the skill.
- Config validation: generic config errors, bad identifiers through `createMigrator`, missing
  `lockName`; factory smoke coverage; all stub adapter methods throw exact errors.
- CI runs `build`, `lint`, `tsc --noEmit`, and tests. **`tsc --noEmit` is mandatory and never
  optional**: vitest does not typecheck by default, so the `expectTypeOf` assertions in
  `types.test.ts` (typed-sqlFiles and wrong-dialect `@ts-expect-error` contracts) are enforced
  only by the typecheck step.
  Dropping typecheck from CI silently disables the package's central type guarantee.
- CI matrix: integration suite against ≥2 `drizzle-orm` minor versions; Node 20 + 22.

---

## 11. Milestones

1. **Scaffold**: pnpm-workspace monorepo (private root, reserved `apps/docs` slot), the
   `packages/core` package, tsconfig (strict, ESM), tsup multi-entry build, biome,
   vitest, path-filtered CI skeleton.
2. **Core engine**: types, defineMigration generics, registry validation, sql.ts, engine.ts against
   the fake adapter. Unit tests green.
3. **pg adapter**: tables.ts, bootstrap.ts + drift assert, locking, `/pg` token + factory
   integration tests green.
4. **CLI + config**: defineConfig validation, the command surface for
   `migrate`/`status`/`validate` with its `connect` lifecycle (the dispatcher moved from core
   into the CLI package in Revision 3).
5. **Commands**: `adopt` with all guards, `generate` with prompts/flags, `--dry-run`.
6. **Hardening**: audit-event forensics docs, README (lead with "why not drizzle's built-in
   migrate()"), the bundled agent skill (§15) written and wired into docs, changesets, npm publish
   dry-run, `--provenance`, publish 0.1.0 alpha tag.
7. **Flip the originating app (optional, separate task)**: versions import `defineMigration` from
   the package, the app's old CLI becomes a `createMigrator(...)` service call or the CLI package
   executable, project migration docs are rewritten, typecheck passes, and one `migrate` runs
   against a scratch database.

---

## 12. Acceptance criteria

- [ ] The repo is a pnpm-workspace monorepo: private root, `packages/core` as the only
      publishable unit, `apps/docs` reserved (empty, private), CI path-filtered to the package,
      publish runs from the package folder with provenance.
- [ ] `npm i @dugstack/drizzle-migrator pg drizzle-orm` + a ~20-line bin script that constructs
      `createMigrator({ dialect: pgDialect, config, migrations })` is the entire consumer setup.
      A dialect-mismatched `db` is a compile error, proven by a `@ts-expect-error` test.
- [ ] One config file controls sqlDir, migrationsDir, schema, table names, lockName, timeouts,
      logger. No hardcoded "gamersmetro" strings anywhere in `src/`.
- [ ] `runSqlFile` is compile-time restricted to the migration's declared `sqlFiles`; cross-migration
      file reuse is a runtime registry error; undeclared-on-disk files fail before the lock is taken.
- [ ] Migration entries are uniformly `v<semver>/index.ts` folders with the canonical **named**
      export `migration_v<major>_<minor>_<patch>` (no default exports); the registry validator
      rejects folder-name/version drift and flat files; registry imports are fully specified ESM
      paths (`./v0.0.3/index.js`).
- [ ] The agent skill (§15) ships inside the CLI package's npm tarball
      (`files: ["dist", "skills"]` in `@dugstack/drizzle-migrator-cli`), installs with standard
      agent tooling, and its command/flag table is test-verified against the CLI command table.
- [ ] `migrate` is transactional per migration with atomic version recording; failures leave an
      audit trail that survives rollback.
- [ ] `adopt` implements from/to/force exactly as §5 and only writes `origin: 'adopted'` rows.
- [ ] `status --json`, `--dry-run`, and `generate --yes` all work as specified.
- [ ] `/mysql` and `/sqlite` subpaths exist and throw informative errors; the adapter interface is
      documented enough to add them without touching the core.
- [ ] The CLI package (`@dugstack/drizzle-migrator-cli`) builds the `migrator` executable with
      the single command table, config discovery, migration-folder auto-discovery, drizzle-out
      resolution, and pg wiring; commands are dispatched by the CLI against only the public
      `Migrator` service methods and covered by a testcontainers end-to-end test.
- [ ] Zero runtime dependencies; peer deps proven by a 2-version CI matrix; ESM-only build with
      per-entry `.d.ts`.
- [ ] Integration tests cover every bullet in §10 and pass locally and in CI.
- [ ] `npm publish --dry-run` shows only `dist/` + README + LICENSE; provenance works.

---

## 13. Open questions (decide during implementation, do not block)

1. `adopt --confirm-database` — keep required (this plan's default, ported from the reference
   implementation) or relax to optional? Recommend keeping it required for v1.
2. Generic `db` typing so `ctx.tx` is typed against the app's schema (nice DX, adds generic
   complexity) — currently `ctx.tx` is the generic drizzle transaction and raw SQL is the
   recommended path for remaps.
3. Compile-time cross-migration duplicate-file detection via a `defineMigrations([...])` registry
   helper (type-level exclusion over tuples) — stretch goal; runtime validation is the contract.

## 14. Operational rules to carry into the README

- Never edit an applied migration; add a new semver migration.
- Never change `lockName` after deployment.
- No network calls or file writes inside migrations; deterministic and retryable after failure.
- Avoid non-transactional statements (`CREATE INDEX CONCURRENTLY`) inside migrations — run them as
  a separate operational step.
- Never run migrations from application startup; deployment commands only.
- Migrator tracking tables must never be added to the app's drizzle-kit schema input (the
  drift-assertion guard exists precisely because those two definitions must be edited together).

---

## 15. The bundled agent skill (a first-class part of the library)

The package ships an **agent skill** — a `SKILL.md` operating manual that AI coding agents
(Claude Code, Codex, Cursor, opencode, and future "npx skills"-style installers) can pick up so
they use the migrator correctly without human re-explanation. This is not documentation garnish;
it is treated as part of the library's public surface, with the same care as the API.

**Location and distribution (Revision 3): the skill belongs to the CLI package** — it documents
commands, which are CLI-owned:

- Lives at `packages/cli/skills/drizzle-migrator/SKILL.md`, shipped in the CLI
  npm tarball via `files: ["dist", "skills"]` (the core package ships `files: ["dist"]` only).
- The skill directory is named `drizzle-migrator` (not `db-migration`) so it never collides with
  an app's own database skill when installed alongside it.
- The CLI package README documents the install story: `npx skills add
  @dugstack/drizzle-migrator-cli` where such installers exist, or a manual copy of
  `skills/drizzle-migrator/` into the agent's skills directory (`.claude/skills/`, `.agents/skills/`,
  etc.). The tarball path is the canonical source any installer can fetch from.
- **Sync contract:** the skill's command/flag table is generated from — or test-diffed against —
  the CLI's single command table (`src/commands.ts`; the skill-sync test lives in the CLI
  package). The skill may never document a flag the CLI doesn't have, and the CLI may not grow a
  flag the skill doesn't mention. A mismatch fails CI.

**Skill content outline** (port and generalize the operational manual; replace every app-specific
path with config-relative language):

1. **Required context** — before touching migrations, read the app's `migrator.config.ts`, the
   versions registry, the latest version folder, and the app's migration docs if present.
2. **Workflow** — construct `createMigrator({ dialect, config, migrations })` → schema change →
   `drizzle-kit generate` → run the migrator's `generate` command to scaffold `v<next>/index.ts`
   from unapplied SQL files → register (or `--register`) →
   `typecheck` → `migrate` against a safe local DB → run `migrate` again and confirm "no pending
   migrations".
3. **Migration entry pattern** — folder-per-version, canonical named export
   `migration_v<major>_<minor>_<patch>`, fully specified registry imports.
4. **Breakpoints and data remaps** — the `from`/`to` range table, the DDL → backfill → constraint
   flow, and the raw-SQL-over-query-builder rule for remaps.
5. **Operational rules** — §14 verbatim (never edit applied migrations, `lockName` immutability,
   no network/fs in migrations, no startup migrations, `CREATE INDEX CONCURRENTLY` exclusion).
6. **Adoption rules** — `adopt` guard rails, including: `--force` narrows to "above the highest
   recorded version"; never widen a range to silence a pending migration; `CI` env refusal.
7. **Verification SQL** — current version, recent log entries, stuck `run.started` forensics,
   adopted-origin listing (the queries from §4.3/§4.4).
8. **Command table** — the five CLI commands and every flag, byte-identical to the CLI's single
   command table.
