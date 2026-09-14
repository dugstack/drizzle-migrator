import { randomUUID } from "node:crypto";
import type { DialectAdapter } from "./adapter.js";
import type { AuditLogEntry } from "./audit.js";
import type { MigratorConfig } from "./config.js";
import { adoptMigrations, getStatus, runMigrations } from "./engine.js";
import { generateMigrationEntry, suggestMigrationEntry } from "./generate.js";
import type { GenerateResult, MigrationEntrySuggestion } from "./generate.js";
import type { Migration } from "./migration.js";
import { validateRegistry } from "./registry.js";
import type { AdoptResult, RunMigrationsResult, StatusReport } from "./result.js";

export type MigrationEntriesValidationResult = { ok: boolean; errors: string[] };

/**
 * Options for `validateMigrationEntries`. Passing `db` additionally records the
 * `validation.started` / `validation.completed|failed` audit trail; omitting it
 * keeps validation completely connection-free.
 */
export type ValidationAuditOptions<TDb> = { db?: TDb };

export interface Migrator<TDb, _TTx> {
  runMigrations(options: { db: TDb; dryRun?: boolean }): Promise<RunMigrationsResult>;
  adoptMigrations(options: {
    db: TDb;
    from?: string;
    to?: string;
    force?: boolean;
    confirmDatabase: string;
  }): Promise<AdoptResult>;
  getStatus(options: { db: TDb }): Promise<StatusReport>;
  /**
   * Validates every migration entry and its required on-disk files and folders.
   * Without `db` this never touches a database; with `db` it appends a
   * `validation.started` event, then `validation.completed` (payload
   * `status: "passed"`) or `validation.failed` (payload `status: "failed"`) —
   * the audit rows' `at` values bracket the validation run. Audit-write
   * failures are logged and ignored: they never replace the validation result.
   */
  validateMigrationEntries(
    options?: ValidationAuditOptions<TDb>,
  ): Promise<MigrationEntriesValidationResult>;
  /** Domain defaults for the next entry: the next patch version and `pending-migration`. */
  suggestMigrationEntry(): MigrationEntrySuggestion;
  /**
   * Scaffolds `v<version>/index.ts` from the unapplied SQL files. Performs no
   * prompting and accepts no `yes` flag: `version` and `name` must be resolved
   * (the CLI calls `suggestMigrationEntry()` first, prompts, then passes
   * explicit values).
   */
  generateMigrationEntry(options: {
    version: string;
    name: string;
    register?: boolean;
  }): Promise<GenerateResult>;
  /**
   * Appends one audit event through the configured audit storage onto the
   * supplied compatible database handle. The CLI uses this for redacted
   * `cli.command` events; custom CLIs receive equal access. Errors propagate —
   * callers decide whether an audit failure is fatal.
   */
  appendAuditEvent(options: { db: TDb; entry: AuditLogEntry }): Promise<void>;
}

/** Audit writes must never mask the operation they observe: failures are logged and swallowed. */
async function emitAudit<TDb, TTx>(
  adapter: DialectAdapter<TDb, TTx>,
  db: TDb,
  config: MigratorConfig,
  entry: AuditLogEntry,
): Promise<void> {
  try {
    await adapter.appendLog(db, config, { ...entry, id: entry.id ?? randomUUID() });
  } catch (error) {
    config.logger.error(`[drizzle-migrator] failed to write audit event "${entry.kind}":`, error);
  }
}

/** Binds project-static inputs once, leaving database handles command-specific. */
// biome-ignore lint/suspicious/noExplicitAny: Adapter generics infer the bound database and transaction types.
export function createMigrator<D extends DialectAdapter<any, any>>(options: {
  dialect: D;
  config: MigratorConfig;
  migrations: Migration[];
}): D extends DialectAdapter<infer TDb, infer TTx> ? Migrator<TDb, TTx> : never {
  const { dialect, config, migrations } = options;

  // Adapter validation preserves dialect-specific identifier rules.
  dialect.quoteIdentifier(config.schema);
  dialect.quoteIdentifier(config.tables.versions);
  dialect.quoteIdentifier(config.tables.logs);

  const migrator: Migrator<unknown, unknown> = {
    runMigrations: ({ db, dryRun }) =>
      runMigrations({ db, adapter: dialect, config, migrations, dryRun }),
    adoptMigrations: ({ db, from, to, force, confirmDatabase }) =>
      adoptMigrations({
        db,
        adapter: dialect,
        config,
        migrations,
        from,
        to,
        force,
        confirmDatabase,
      }),
    getStatus: ({ db }) => getStatus({ db, adapter: dialect, config, migrations }),
    suggestMigrationEntry: () => suggestMigrationEntry(migrations),
    async validateMigrationEntries(options = {}) {
      const { db } = options;
      // The start marker is written before validating so the audit rows' `at`
      // values genuinely bracket the run.
      if (db !== undefined) {
        await emitAudit(dialect, db, config, { kind: "validation.started" });
      }
      try {
        const sorted = await validateRegistry(migrations, config);
        if (db !== undefined) {
          await emitAudit(dialect, db, config, {
            kind: "validation.completed",
            payload: { status: "passed", migrations: sorted.length },
          });
        }
        return { ok: true, errors: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (db !== undefined) {
          await emitAudit(dialect, db, config, {
            kind: "validation.failed",
            payload: { status: "failed" },
            detail: message,
          });
        }
        return { ok: false, errors: [message] };
      }
    },
    generateMigrationEntry: (generateOptions) =>
      generateMigrationEntry({ config, migrations, ...generateOptions }),
    appendAuditEvent: ({ db, entry }) =>
      dialect.appendLog(db, config, { ...entry, id: entry.id ?? randomUUID() }),
  };

  return migrator as D extends DialectAdapter<infer TDb, infer TTx> ? Migrator<TDb, TTx> : never;
}
