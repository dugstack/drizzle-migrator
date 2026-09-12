import type { DialectAdapter } from "./adapter.js";
import { createMigrationCli } from "./cli.js";
import type { MigratorConfig } from "./config.js";
import { adoptMigrations, getStatus, runMigrations } from "./engine.js";
import { generateMigrationEntry } from "./generate.js";
import type { GenerateResult } from "./generate.js";
import type { Migration } from "./migration.js";
import { validateRegistry } from "./registry.js";
import type { AdoptResult, RunMigrationsResult, StatusReport } from "./result.js";

export type ValidateResult = { ok: boolean; errors: string[] };

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
  validate(): Promise<ValidateResult>;
  generateMigrationEntry(options: {
    version?: string;
    name?: string;
    yes?: boolean;
    register?: boolean;
  }): Promise<GenerateResult>;
  createCli(options: {
    connect: () => Promise<{ db: TDb; close: () => Promise<void> }>;
    /** Defaults to process.argv.slice(2); the CLI executable forwards its own argv. */
    argv?: readonly string[];
  }): Promise<void>;
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
    async validate() {
      try {
        await validateRegistry(migrations, config);
        return { ok: true, errors: [] };
      } catch (error) {
        return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
      }
    },
    generateMigrationEntry: (generateOptions) =>
      generateMigrationEntry({ config, migrations, ...generateOptions }),
    createCli: ({ connect, argv }) =>
      createMigrationCli({ adapter: dialect, config, migrations, connect, argv }),
  };

  return migrator as D extends DialectAdapter<infer TDb, infer TTx> ? Migrator<TDb, TTx> : never;
}
