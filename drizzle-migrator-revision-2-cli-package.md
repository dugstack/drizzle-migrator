# REVISION 2 — the CLI package: `migrator` executable + auto-discovery

| | |
| --- | --- |
| **Applies to** | The repo that completed Milestones 1–6 of `drizzle-migrator-package-plan.md` (core shipped, README + skill + release pipeline in place) |
| **Adds** | `packages/drizzle-migrator-cli` — the executable `migrator` command: config discovery, migration-folder auto-discovery, drizzle-out resolution, and pg connection wiring |
| **Does NOT change** | The core engine, adapter seam, CLI command/flag table, tracking schemas, typed-sqlFiles contract, `defineMigration`, or any existing `Migrator` method signature (one additive optional parameter excepted, below) |

**Meta-rule:** same as Revision 1 — this document is a change order, and its base-plan edits
(§7 below) are applied back into `drizzle-migrator-package-plan.md` so the base plan stays the
single source of truth.

---

## 1. What changed and why

The core package's consumer setup requires a hand-written bin script (~20 lines) that wires
`pg.Client` → `drizzle(client)` → `createMigrator(...)` → `createCli`, plus a manually maintained
versions registry (`versions/index.ts`). **Decision:** the standard project shape should be
`npm i` + one config file. The new companion package `@dugstack/drizzle-migrator-cli` owns all of
that wiring and ships the `migrator` executable:

```sh
pnpm migrator generate
pnpm migrator migrate
pnpm migrator status
pnpm migrator validate
pnpm migrator --config ./db/migrator.config.ts status
```

Package tree:

```text
packages/
  drizzle-migrator/       # core + adapters — programmatic API unchanged
  drizzle-migrator-cli/   # executable + discovery
```

**Decisions encoded (do not re-litigate):**

- **The core programmatic API is unchanged.** `createMigrator({ dialect, config, migrations })`
  and every `Migrator` method keep their signatures. The engine, adapter seam, tracking-table
  DDL, audit vocabulary, and the §7 command table are untouched. The single exception is
  additive: `Migrator.createCli` accepts an optional `argv` (default `process.argv.slice(2)`) so
  the executable can forward its own argv to the core dispatcher instead of mutating
  `process.argv`. The internal `CreateMigrationCliOptions` already had this field; the interface
  simply exposes it now.
- **One dispatcher.** The CLI executable does not re-implement commands. It resolves config +
  migrations + connection, calls `createMigrator(...)`, and forwards `migrate` / `adopt` /
  `status` / `generate` / `validate` (and their flags) to `Migrator.createCli`. Output, audit
  events (`cli.command`), and exit codes remain core-owned.
- **The CLI owns the pg wiring.** `pg.Client` (one dedicated, session-scoped client per command —
  the advisory lock must share one connection) → `drizzle(client)` → `pgDialect` →
  `createMigrator`. The core stays dialect-token based.
- **Config and entries stay normal TypeScript**, loaded through **jiti** (the CLI's only runtime
  dependency beyond `pg` + `drizzle-orm` + the core). No bundler, no build step for user code.
- **No manual registry file.** The CLI auto-discovers `<migratorOutDir>/v<semver>/index.ts`.
  A leftover `index.ts` registry in `migratorOutDir` is ignored with a note, not executed.
- **v1 is postgres-only.** The CLI config is a `dialect`-discriminated union with one member;
  future dialects join as new members and the CLI grows matching connection blocks.

---

## 2. Exact type specifications

### CLI config (`packages/drizzle-migrator-cli/src/config.ts`)

```ts
export type MigratorCliConfigInput = PostgresCliConfigInput; // discriminated by `dialect`

export type PostgresCliConfigInput = {
  dialect: "postgres";               // requires the `postgres` block (compile-time enforced)
  postgres: { connectionString: string };
  migratorOutDir: string;            // required
  drizzleOutDir?: string;            // wins over the drizzle config's `out`
  lockName?: string;                 // default "drizzle-migrator"
  schema?: string;                   // pass-through core config
  tables?: Partial<MigratorTablesConfig>;
  lock?: Partial<MigratorLockConfig>;
  logger?: MigratorLogger;
};

export function defineConfig(input: MigratorCliConfigInput): MigratorCliConfig;
export function resolveCliConfig(input: unknown): MigratorCliConfig; // re-validates loaded exports
```

Validation rules: `dialect: "postgres"` requires `postgres.connectionString` (non-empty;
`postgres://`/`postgresql://` URL or key=value string); `migratorOutDir` required; paths must be
filesystem paths (no URLs, no null bytes); `lockName` defaults to `"drizzle-migrator"`.
`schema` / `tables` / `lock` / `logger` pass through to the core `defineConfig`, which validates
them.

### SQL directory resolution (`src/drizzle-out.ts`)

1. `drizzleOutDir` from the CLI config — **wins**.
2. The `out` field of `drizzle.config.{ts,mts,cts,js,mjs,cjs,json}` in the cwd (default export or
   named `out` export; a broken drizzle config errors, it does not silently fall back).
3. Fallback `"./drizzle"` (with an informational log).

### Migration auto-discovery (`src/discovery.ts`)

- Scans `<migratorOutDir>/v<semver>/index.ts`; entries are sorted numerically (`0.10.0 > 0.9.0`).
- Hard errors: folder not named `v<semver>`; flat `<version>.ts` files (folder-per-version is
  uniform, matching the core registry validator); version folder without `index.ts`; entry
  exporting zero or multiple migrations; entry `version` not equal to the folder's version.
- A missing `migratorOutDir` yields an empty list with an informational log (so `generate` can
  bootstrap a fresh project); the core registry validator still guards `migrate`/`status`.
- `defineConfig` is authoring sugar only — the runner re-validates whatever the config file
  exports, so a plain-object default export works.

### Executable (`package.json` + `src/bin.ts`)

```jsonc
{ "bin": { "migrator": "./dist/bin.js" } }
```

Global flags (recognized before the command only): `--config <path>` / `--config=<path>` and
`--help/-h`. Everything after the first positional token is forwarded verbatim. The executable
prints its own usage for `--help` and empty invocations (it cannot import the core's internal
dispatch table through the export map); `test/usage-sync.test.ts` diff-guard that table against
the core's `CLI_COMMANDS` — the same mechanism as the core's skill-sync test.

### Public export surface (`@dugstack/drizzle-migrator-cli`)

`defineConfig`, `resolveCliConfig`, `toCoreConfig`, `runCli`, `parseGlobalArgv`,
`connectPostgres`, `discoverMigrations`, `findMigratorConfigPath`, `findDrizzleConfigPath`,
`resolveSqlDir`, `createModuleLoader`, `unwrapDefaultExport`, `compareVersions`, `printUsage`,
`USAGE_COMMANDS`, `DEFAULT_LOCK_NAME`, plus their types (`MigratorCliConfig(Input)`,
`PostgresCliConfigInput`, `PostgresCliConnection`, `PgConnection`, `GlobalFlags`, `ModuleLoader`,
`UsageCommand`, `UsageFlag`).

---

## 3. Dependency and release notes

- `@dugstack/drizzle-migrator-cli` declares `@dugstack/drizzle-migrator` (workspace), `pg`,
  `drizzle-orm`, and `jiti` as **regular dependencies** — the executable must work standalone.
  The core keeps zero runtime dependencies and peer-only `drizzle-orm`/`pg`.
- The drizzle-orm peer-range CI matrix applies to the core package; the CLI pins its own
  `drizzle-orm` range and runs its own testcontainers suite.
- Release: publish both packages (`pnpm -r publish --access public --provenance` in the gated
  release pipeline; private workspaces are skipped automatically).

---

## 4. Testing requirements (all implemented)

- Postgres config type requirements: `@ts-expect-error` — missing `postgres` block, missing
  `connectionString`, unknown dialect; enforced by CI `tsc --noEmit`.
- Config validation (runtime, on loaded exports): non-object export, missing/empty connection
  string, non-postgres URL scheme, neither URL nor key=value, missing `migratorOutDir`, URL in a
  path field, unknown dialect.
- Config discovery: default basename + extension precedence in cwd; explicit `--config` (with
  extension inference); loud failures with the searched path in the message.
- Manual versus Drizzle-derived output path: `drizzleOutDir` wins; drizzle config `out` (default,
  named, and JSON variants); missing `out`; missing drizzle config; broken drizzle config.
- Migration-folder discovery: numeric sort; helper exports tolerated; bad folder names; missing
  `index.ts`; folder/version drift; multiple/zero migration exports; flat files; missing folder
  (empty list + note); leftover registry file ignored with a note.
- CLI command forwarding: global-flag parsing/strip tests plus `runCli` through the real core
  dispatcher — `validate` happy path (no DB), `--config` stripping with a custom config path,
  unknown command flags rejected by the core, unknown commands rejected by the core, config
  validation errors surfaced with exit code 1, `--help` without any config on disk.
- Full PostgreSQL Testcontainers path: a realistic fixture project (plain-object config reading
  `DATABASE_URL`, no drizzle config → `./drizzle` fallback, no registry file) driven through
  `runCli`: `migrate` applies and records `origin: 'executed'`; second `migrate` is a no-op;
  `status --json` parses; `generate --yes` scaffolds the next entry from a new unapplied SQL
  file; `migrate` applies it; an unreachable `DATABASE_URL` exits 1.

## 5. What does NOT change

- §4.1 migration authoring: entries are identical files whether discovered by the CLI or
  registered manually; `defineMigration` and the typed-sqlFiles contract untouched.
- §5 engine semantics, §7 command table, §8 generate behavior, §9 adapter seam.
- The core's export map and public API (one additive optional `argv` on `Migrator.createCli`).
- The bundled skill and its sync test (command/flag table unchanged).

## 6. Acceptance checks

- [x] `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` all green (core 96
      tests, CLI 52 tests, both including testcontainers suites).
- [x] `pnpm migrator --help` prints usage without a config or database; bare `migrator` does the
      same; the usage table is test-synced against the core dispatch table.
- [x] `migrator generate --yes` + `migrator migrate` against a real Postgres container work with
      no bin script and no registry file.
- [x] The core's existing 96-test suite passes unmodified except the additive `argv` plumbing.

## 7. Base-plan sync (applied to `drizzle-migrator-package-plan.md`)

1. **§3 tree** — added the `packages/drizzle-migrator-cli` block (src + test file list).
2. **§3 repo-shape rules** — the published-units bullet now names both packages.
3. **§7** — added the "CLI package" subsection (config shape, resolution rules, discovery rules,
   pg wiring, additive `argv` note, usage-sync mechanism).
4. **§12** — added the CLI-package acceptance criterion.

## 8. Stop condition

Revision 2 is complete: the CLI package is implemented, tested (unit + testcontainers),
documented (own README + core README install split + quick starts), and synced into the base
plan. Engine and adapter code is untouched beyond the additive `argv` parameter.
