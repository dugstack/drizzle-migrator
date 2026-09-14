# REVISION 1 — API shape: core factory + dialect token

| | |
| --- | --- |
| **Applies to** | The repo that completed Milestone 1 (scaffold) of `drizzle-migrator-package-plan.md` |
| **Must land** | **Before** Milestones 2+ begin |
| **Supersedes** | Base plan §7 (Public API surface) in part; touches §3, §6, §8, §9, §10, §12, §15 in minor ways (enumerated in §7 of this document) |
| **Does NOT touch** | §4.1 migration authoring, §5 engine semantics, §8 generate behavior, the CLI command table, the subpath export map, the typed-sqlFiles contract |

**Meta-rule:** this document is a change order, not a second spec. As part of this work you must
apply the enumerated edits back into `drizzle-migrator-package-plan.md` (§7 below) so the base
plan remains the single source of truth for every future agent. Read the base plan first; this
revision only redirects the API shape.

---

## 1. What changed and why

The base plan had consumers importing commands directly from the dialect subpath
(`runMigrations` from `@dugstack/drizzle-migrator/pg`). **Decision (superseding):** the consumer
initializes a core factory with a dialect token, then talks only to the returned `Migrator`
instance — the Knex/TypeORM-style shape:

```ts
// app: bin/migrate.ts — the ONLY file that knows the dialect
import { createMigrator, defineConfig } from "@dugstack/drizzle-migrator";
import { pgDialect } from "@dugstack/drizzle-migrator/pg";
import { migrations } from "../db/migrator/versions/index.js";

const migrator = createMigrator({
  dialect: pgDialect,   // the token carries the db/tx types
  config: defineConfig({ sqlDir: "./drizzle", lockName: "myapp:db:migrations" }),
  migrations,
});

migrator.createCli({ connect: () => makeDb() }); // argv dispatch: migrate/adopt/status/generate/validate

// programmatic use:
await migrator.runMigrations({ db });
```

```ts
// app: migration files — UNCHANGED, still dialect-free, still import from core
import { defineMigration } from "@dugstack/drizzle-migrator";

export const migration_v0_0_3 = defineMigration({ version: "0.0.3", /* … */ });
```

**Why this stays type-coherent:** `DialectAdapter<TDb, TTx>` (base plan §9) already carries the
db/tx generics, so `createMigrator` returns a `Migrator` whose methods are typed over the
dialect's database handle automatically. Passing a MySQL-style db to a pg-bound migrator is a
**compile error**. The typed `runSqlFile` generic is untouched — it lives on `defineMigration`.

**Decisions encoded (do not re-litigate):**

- `config` and `migrations` are **constructor-time**. They are project-static; command methods
  take only `{ db, ...options }`. The CLI factory needs nothing but `connect`.
- Dialect subpaths export **only the token** (+ its type). No pre-bound convenience re-exports —
  one way to do everything.
- `defineConfig` is a core export. Dialect-specific identifier rules are enforced at
  `createMigrator` time by round-tripping `config.schema` and `config.tables.*` through the
  dialect's own `quoteIdentifier` — fail fast, dialect-appropriate, zero extra API surface.

---

## 2. Exact type specifications

### `src/core/migrator.ts` (new file)

```ts
export interface Migrator<TDb, TTx> {
  runMigrations(options: { db: TDb; dryRun?: boolean }): Promise<RunMigrationsResult>;
  adoptMigrations(options: {
    db: TDb;
    from?: string;
    to?: string;
    force?: boolean;
    confirmDatabase: string;
  }): Promise<AdoptResult>;
  getStatus(options: { db: TDb }): Promise<StatusReport>;
  /** Registry lint: versions, duplicates, sqlFiles uniqueness, on-disk existence. No db. */
  validateMigrationEntries(): Promise<MigrationEntriesValidationResult>;
  /** §8 of the base plan; config + migrations come from construction. */
  generateMigrationEntry(options: {
    version?: string;
    name?: string;
    yes?: boolean;
    register?: boolean;
  }): Promise<GenerateResult>;
  /** CLI dispatch — commands and flags byte-identical to the base plan's §7 command table. */
  createCli(options: {
    connect: () => Promise<{ db: TDb; close: () => Promise<void> }>;
  }): Promise<void>;
}

export type MigrationEntriesValidationResult = { ok: boolean; errors: string[] };

export function createMigrator<D extends DialectAdapter<any, any>>(options: {
  dialect: D;
  config: MigratorConfig;
  migrations: Migration[];
}): D extends DialectAdapter<infer TDb, infer TTx> ? Migrator<TDb, TTx> : never;
```

### `src/pg/index.ts` (rewritten — exports the token only)

```ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DialectAdapter } from "../core/adapter.js";
// MigratorTransaction per the base plan's types.ts
import type { MigratorTransaction } from "../core/types.js";

export type PgDialect = DialectAdapter<
  NodePgDatabase<Record<string, never>>,
  MigratorTransaction
>;

export const pgDialect: PgDialect = { /* the §9 implementation — unchanged */ };
```

### `src/mysql/index.ts` and `src/sqlite/index.ts` (rewritten stubs)

```ts
export type MysqlDialect = DialectAdapter<never, never>;

export const mysqlDialect: MysqlDialect = stubDialect("mysql");

// stubDialect: a helper whose every adapter method throws
// `new Error("<id> adapter is not implemented in v1")` when invoked.
```

Rules for stubs:

- Importing the token is side-effect-free.
- Invoking **any** adapter method throws `"<id> adapter is not implemented in v1"`.
- Failure therefore surfaces at first use (e.g. `migrator.runMigrations`), not at import time —
  safe for consumers who typecheck against the token without executing.

---

## 3. Public export surface (complete, after this revision)

| module | exports |
| --- | --- |
| `@dugstack/drizzle-migrator` | `createMigrator`, `Migrator`, `defineMigration`, `defineConfig`, types: `Migration`, `MigrationContext<TFiles>`, `RunSqlFileRange`, `MigratorConfig`, `RunMigrationsResult`, `AdoptResult`, `StatusReport`, `GenerateResult`, `MigrationEntriesValidationResult`, `MigratorLogger`, `AuditLogEntry` |
| `@dugstack/drizzle-migrator/pg` | `pgDialect`, `PgDialect` |
| `@dugstack/drizzle-migrator/mysql` | `mysqlDialect`, `MysqlDialect` |
| `@dugstack/drizzle-migrator/sqlite` | `sqliteDialect`, `SqliteDialect` |

Nothing else. The engine functions (`runMigrations`, `adoptMigrations`, `getStatus`,
`generateMigrationEntry`, `createMigrationCli`) become **internal** to `src/core/` — no longer
exported from the core index; the `Migrator` interface is their only public door.

---

## 4. Scaffold-update checklist

File by file (everything exists as a compiling stub from Milestone 1):

1. **`src/core/migrator.ts`** — new: `Migrator` interface + `createMigrator` implementation
   (binds adapter + config + migrations, validates config identifiers through
   `dialect.quoteIdentifier`, returns the dialect-typed `Migrator`).
2. **`src/core/engine.ts`** — keep the orchestration functions; they now take the adapter as a
   parameter (they likely already do). They stay internal.
3. **`src/core/cli.ts`** — `createMigrationCli` free function becomes an internal dispatcher
   invoked by `Migrator.createCli({ connect })`. **argv parsing and the command/flag table are
   unchanged** — the skill-sync test contract is untouched.
4. **`src/core/index.ts`** — export per the table in §3; remove the now-internal function exports.
5. **`src/pg/index.ts`** — per §2 above; delete any `runMigrations`/`createMigrationCli`/
   `defineConfig` re-exports.
6. **`src/mysql/index.ts`, `src/sqlite/index.ts`** — per §2 above.
7. **tsup entries** — unchanged: same four subpaths, ESM + dts.
8. **`package.json` exports map** — unchanged.

---

## 5. What does NOT change

- **§4.1** migration authoring: folder-per-version, canonical named exports, fully specified
  registry imports — migrations import `defineMigration` from core, exactly as before.
- **§5** engine semantics: locking, bootstrap + drift assertion, per-migration transactions,
  adopt guards, dry-run.
- **§8** generate behavior: scanning, prompts, defaults, `--yes`, scaffolding,
  `--register` snippet — only its *options source* moves to the constructed migrator.
- **CLI command table**: `migrate [--dry-run]`, `adopt [--from= --to= --force
  --confirm-database=]`, `status [--json]`, `generate [--version= --name= --yes --register]`,
  `validate` — byte-identical.
- **§9** `DialectAdapter` interface shape, tracking-table DDL, subpath export map,
  typed-sqlFiles contract, bundled-skill placeholder file.

---

## 6. Acceptance checks

- [ ] `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` all green.
- [ ] `createMigrator({ dialect: pgDialect, config, migrations })` returns an object exposing all
      six `Migrator` methods (smoke test).
- [ ] Stub-token test: invoking any method of `mysqlDialect`/`sqliteDialect` rejects with
      `"<id> adapter is not implemented in v1"`; importing the tokens has no side effects.
- [ ] Type test: `@ts-expect-error` — passing a non-`NodePgDatabase` value to
      `pgMigrator.runMigrations({ db })` fails compilation (this test must fail to compile if the
      inference regresses; CI's `tsc --noEmit` enforces it — see base plan §10 rule).
- [ ] `npm publish --dry-run` from `packages/drizzle-migrator` still shows only
      `dist/`, `skills/`, README, LICENSE.
- [ ] Skill placeholder untouched; skill-sync test (when written in Milestone 2) will diff the
      unchanged command table.

---

## 7. Base-plan sync (apply these edits to `drizzle-migrator-package-plan.md` as part of this work)

1. **§7** — rewrite to the shape in this document (core factory table, `/pg` token-only, exact
   type specs, constructor-time config/migrations decision). Replace the free-function API block
   entirely.
2. **§3 tree** — add `core/migrator.ts` ("createMigrator factory + Migrator interface"); change
   `pg/index.ts` comment to "exports only the pgDialect token"; change mysql/sqlite comments to
   "tokens; every adapter method throws at first use".
3. **§6 config sample** — `defineConfig` imported from core; add the note about identifier
   validation via `dialect.quoteIdentifier` at `createMigrator` time.
4. **§8** — reword option sourcing: config + migrations come from the constructed `Migrator`;
   behavior otherwise unchanged.
5. **§9** — add: "Dialect subpaths export exactly one value — the adapter token (+ its type).
   Stub tokens throw at first use, not at import."
6. **§10** — note engine tests exercise `createMigrator` with a fake dialect token; keep the
   mandatory-`tsc --noEmit` rule (it is what enforces the new wrong-dialect type test).
7. **§12** — reword the consumer-setup criterion to the factory shape; add criterion: "a
   dialect-mismatched `db` is a compile error, proven by a `@ts-expect-error` test".
8. **§15** — workflow mentions `createMigrator` once; command table unchanged.

---

## 8. Stop condition

This revision is the complete scope: API shape only. **No engine logic, no adapter
implementation, no commands.** When the acceptance checks pass and the base plan is synced,
stop and report (files touched, verification outputs, any new plan contradictions found).
Await the next kickoff prompt (Milestones 2–3) — it is deliberately not included here.
