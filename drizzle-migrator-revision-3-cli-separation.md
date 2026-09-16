# REVISION 3 — CLI separation, optional validation audits, and CLI-owned skill

| | |
| --- | --- |
| **Applies to** | Revision 2 workspace: core migrator plus companion CLI package |
| **Changes** | Removes CLI dispatch from core; makes companion package sole CLI owner |
| **Preserves** | Engine semantics, migration formats, command names, flag behavior, and tracking-table schema |

**Meta-rule:** apply resulting base-plan edits back into
`drizzle-migrator-package-plan.md`. Keep this document as revision change order.

---

## 1. Boundary

`@dugstack/drizzle-migrator` remains pure programmatic service. It owns domain operations,
validation, migration-entry generation, and audit persistence. It never parses argv, prints
output, sets exit codes, reads stdin, opens connections, or ships CLI guidance.

`@dugstack/drizzle-migrator-cli` owns command definitions, flag parsing, usage text, prompts,
rendering, exit codes, configuration discovery, migration discovery, and Postgres connection
lifecycle. Delete `packages/core/src/core/cli.ts` and remove
`Migrator.createCli`.

Keep command names and flags unchanged:

| command | flags |
| --- | --- |
| `migrate` | `--dry-run` |
| `adopt` | `--from= --to= --force --confirm-database=` |
| `status` | `--json` |
| `generate` | `--version= --name= --yes --register` |
| `validate` | – |

Define this table once inside CLI package. CLI usage rendering, command dispatch, README checks,
and bundled-skill checks consume this single definition.

## 2. Core public API

`Migrator<TDb, TTx>` retains `runMigrations`, `adoptMigrations`, and `getStatus`. Replace
remaining CLI-shaped methods with these service methods:

```ts
type ValidationAuditOptions<TDb> = { db?: TDb };

type MigrationEntrySuggestion = {
  version: string;
  name: string;
};

interface Migrator<TDb, TTx> {
  validateMigrationEntries(
    options?: ValidationAuditOptions<TDb>,
  ): Promise<MigrationEntriesValidationResult>;
  suggestMigrationEntry(): MigrationEntrySuggestion;
  generateMigrationEntry(options: {
    version: string;
    name: string;
    register?: boolean;
  }): Promise<GenerateResult>;
  appendAuditEvent(options: { db: TDb; entry: AuditLogEntry }): Promise<void>;
}
```

`validateMigrationEntries()` still validates every migration entry, SQL-file ownership and
existence, and version-folder layout. Without `db`, behavior remains connection-free. With `db`,
write `validation.started`, then `validation.completed` or `validation.failed` audit events.
Audit-row `at` values provide start and finish times. Completion payload records
`status: "passed"`; failure payload records `status: "failed"`. Audit-write failures are ignored
and never replace validation results or validation errors.

`suggestMigrationEntry()` owns domain defaults: next patch version and default name
`"pending-migration"`. `generateMigrationEntry()` performs no prompting, accepts no `yes` flag,
and requires resolved `version` and `name`. CLI calls suggestion first, prompts when `--yes` is
absent, then calls generation with explicit values.

`appendAuditEvent()` binds configured audit storage to a supplied compatible database handle.
CLI uses it for redacted `cli.command` events; custom CLIs receive equal access.

## 3. CLI behavior

Make `postgres` configuration optional. Commands requiring a database (`migrate`, `adopt`, and
`status`) fail before execution when `postgres.connectionString` is absent. `generate` remains
connection-free. `validate` remains connection-free when no connection string exists.

When `validate` has a configured connection string, CLI opens one dedicated connection, passes
its `db` to `validateMigrationEntries`, then always closes it. When absent, CLI calls validation
without options. Connection failures and audit failures do not prevent validation when no
connection was requested; a requested connection failure exits with CLI error status.

CLI parses and validates every command flag. CLI renders all success and failure output, maps
errors to exit codes, and closes every opened connection in `finally` blocks. Core receives only
structured arguments and database handles.

## 4. Skill, packaging, docs

Move `skills/drizzle-migrator/SKILL.md` from core package into CLI package. Change frontmatter
and opening description to identify `@dugstack/drizzle-migrator-cli`. Keep operational migration
guidance, command table, and safety rules. Keep core API documentation in core README.

Move skill-sync tests into CLI package. Tests parse bundled skill command table and compare it
with CLI command definition. Tests also reject undocumented or stale flags. Include `skills` in
CLI package `files`; remove it from core package `files`.

Update both READMEs, revision documents, base package plan, export inventories, and tests for
removed `createCli`, CLI-owned dispatch, optional Postgres configuration, suggestion API, and
new audit behavior.

## 5. Acceptance checks

- [x] Core imports contain no CLI dispatcher, argv parsing, `process.exitCode`, or readline usage.
- [x] CLI command table drives dispatch, usage, README/skill synchronization, and flag validation.
- [x] `migrator validate` succeeds without Postgres configuration and creates no audit row.
- [x] `migrator validate` with Postgres configuration records started plus terminal audit event.
- [x] Failed validation records `validation.failed`; audit storage failures preserve validation result.
- [x] Database commands reject absent Postgres configuration before connection attempts.
- [x] `generate --yes` uses core suggestion defaults; interactive generate uses CLI prompts.
- [x] Custom CLI callers use only public `Migrator` service methods.
- [x] Core and CLI build, typecheck, lint, and test suites pass.

---

**Completion note.** Revision 3 is implemented: `src/core/cli.ts` and `Migrator.createCli` are
gone; the four service methods (`validateMigrationEntries`, `suggestMigrationEntry`,
`generateMigrationEntry`, `appendAuditEvent`) form the core's entire CLI-facing surface; the
companion package owns the single command table (`src/commands.ts`), argv parsing, prompts,
usage, dispatch, output, exit codes, optional Postgres configuration, and the bundled skill
(moved from core with its sync tests). Command names and flags are unchanged. Base-plan edits
applied to `drizzle-migrator-package-plan.md` per the meta-rule.
