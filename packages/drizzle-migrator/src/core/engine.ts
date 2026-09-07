import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DialectAdapter } from "./adapter.js";
import type { AuditLogEntry } from "./audit.js";
import type { MigratorConfig } from "./config.js";
import type { Migration, MigrationContext } from "./migration.js";
import { compareVersions, sortMigrations, sqlFilesOf, validateRegistry } from "./registry.js";
import type { AdoptResult, RunMigrationsResult, StatusReport } from "./result.js";
import { sliceStatements, splitStatements } from "./sql.js";

const STATUS_RECENT_LOG_LIMIT = 20;
const DRY_RUN_STATEMENT_PREVIEW_LENGTH = 120;

export type EngineOptions<TDb = unknown, TTx = unknown> = {
  db: TDb;
  adapter: DialectAdapter<TDb, TTx>;
  config: MigratorConfig;
  migrations: readonly Migration[];
  dryRun?: boolean;
};

export type AdoptOptions<TDb = unknown, TTx = unknown> = {
  db: TDb;
  adapter: DialectAdapter<TDb, TTx>;
  config: MigratorConfig;
  migrations: readonly Migration[];
  from?: string;
  to?: string;
  force?: boolean;
  confirmDatabase: string;
};

export type StatusOptions<TDb = unknown, TTx = unknown> = {
  db: TDb;
  adapter: DialectAdapter<TDb, TTx>;
  config: MigratorConfig;
  migrations: readonly Migration[];
};

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export async function runMigrations<TDb, TTx>(
  options: EngineOptions<TDb, TTx>,
): Promise<RunMigrationsResult> {
  const { db, adapter, config, migrations, dryRun = false } = options;
  const sorted = await validateRegistry(migrations, config);

  const emitAudit = async (entry: AuditLogEntry): Promise<void> => {
    if (dryRun && entry.kind !== "dryrun.completed") {
      return;
    }
    try {
      await adapter.appendLog(db, config, { ...entry, id: entry.id ?? randomUUID() });
    } catch (error) {
      config.logger.error(`[drizzle-migrator] failed to write audit event "${entry.kind}":`, error);
    }
  };

  const lockStartedAt = Date.now();
  let acquired = false;
  try {
    try {
      await adapter.acquireLock(db, config.lockName, config.lock);
      acquired = true;
    } catch (error) {
      await emitAudit({
        kind: "lock.timeout",
        payload: { waitTimeoutMs: config.lock.waitTimeoutMs },
        detail: errorDetail(error),
      });
      throw error;
    }
    await emitAudit({ kind: "lock.acquired", payload: { waitMs: Date.now() - lockStartedAt } });

    await adapter.bootstrapTrackingTables(db, config);
    await emitAudit({
      kind: "bootstrap.completed",
      payload: { schema: config.schema, tables: config.tables },
    });

    const appliedRows = await adapter.listAppliedVersionRows(db, config);
    const appliedVersions = new Set(appliedRows.map((row) => row.version));
    const pending = sorted.filter((migration) => !appliedVersions.has(migration.version));
    const skipped = sorted
      .filter((migration) => appliedVersions.has(migration.version))
      .map((migration) => migration.version);
    const currentVersion = [...appliedVersions].sort(compareVersions).at(-1) ?? null;
    config.logger.info(
      `drizzle-migrator: current version ${currentVersion ?? "none"}; pending ${
        pending.length === 0 ? "none" : pending.map((migration) => migration.version).join(", ")
      }`,
    );

    if (dryRun) {
      for (const migration of pending) {
        config.logger.info(`[dry-run] ${migration.version} "${migration.name}"`);
        const files = sqlFilesOf(migration);
        if (files.length === 0) {
          config.logger.info(
            "[dry-run]   no SQL files declared (raw statements in up() cannot be previewed)",
          );
        }
        for (const file of files) {
          const content = await readFile(resolve(config.sqlDir, file), "utf8");
          const statements = splitStatements(content);
          config.logger.info(`[dry-run]   ${file}: ${statements.length} statement(s)`);
          for (const statement of statements) {
            const preview =
              statement.length > DRY_RUN_STATEMENT_PREVIEW_LENGTH
                ? `${statement.slice(0, DRY_RUN_STATEMENT_PREVIEW_LENGTH)}...`
                : statement;
            config.logger.info(`[dry-run]     ${preview}`);
          }
        }
      }
      await emitAudit({
        kind: "dryrun.completed",
        payload: { pending: pending.map((m) => m.version) },
      });
      return { applied: [], skipped, dryRun: pending.map((migration) => migration.version) };
    }

    const applied: string[] = [];
    for (const migration of pending) {
      const runId = randomUUID();
      const migrationStartedAt = Date.now();
      await emitAudit({
        kind: "run.started",
        version: migration.version,
        runId,
        payload: { name: migration.name, runId },
      });
      try {
        await adapter.runInTransaction(db, async (tx) => {
          const ctx: MigrationContext<readonly string[]> = {
            tx,
            execute: (sql) => adapter.executeRaw(tx, sql),
            runSqlFile: async (file, range) => {
              const files = sqlFilesOf(migration);
              if (!files.includes(file)) {
                throw new Error(
                  `SQL file "${file}" is not declared by migration ${migration.version}; declared: ${
                    files.join(", ") || "none"
                  }`,
                );
              }
              const content = await readFile(resolve(config.sqlDir, file), "utf8");
              const statements = sliceStatements(splitStatements(content), range);
              for (const statement of statements) {
                await adapter.executeRaw(tx, statement);
              }
            },
            audit: (kind, payload) =>
              adapter.appendLog(tx, config, {
                kind,
                version: migration.version,
                runId,
                payload,
              }),
          };
          await migration.up(ctx);
          await adapter.recordVersion(tx, config, {
            version: migration.version,
            name: migration.name,
            origin: "executed",
          });
        });
      } catch (error) {
        await emitAudit({
          kind: "run.failed",
          version: migration.version,
          runId,
          payload: { name: migration.name, runId },
          detail: errorDetail(error),
        });
        throw error;
      }
      await emitAudit({
        kind: "run.applied",
        version: migration.version,
        runId,
        payload: { name: migration.name, runId, durationMs: Date.now() - migrationStartedAt },
      });
      applied.push(migration.version);
    }
    return { applied, skipped, dryRun: [] };
  } finally {
    if (acquired) {
      try {
        await adapter.releaseLock(db, config.lockName);
        await emitAudit({ kind: "lock.released" });
      } catch (error) {
        config.logger.error(
          `[drizzle-migrator] failed to release lock "${config.lockName}":`,
          error,
        );
      }
    }
  }
}

export async function adoptMigrations<TDb, TTx>(
  options: AdoptOptions<TDb, TTx>,
): Promise<AdoptResult> {
  const { db, adapter, config, migrations, from, to, force = false, confirmDatabase } = options;

  if (process.env.CI) {
    throw new Error(
      "adopt refuses to run when the CI env var is set — adoption is a manual, one-time step",
    );
  }

  const sorted = sortMigrations(migrations);
  const registryVersions = sorted.map((migration) => migration.version);
  const known = new Set(registryVersions);

  const fromVersion = from ?? sorted[0]?.version;
  const toVersion = to ?? sorted.at(-1)?.version;

  if (!fromVersion || !known.has(fromVersion)) {
    throw new Error(
      `adopt: unknown "from" version ${JSON.stringify(from ?? null)}. Registry: ${
        registryVersions.join(", ") || "(empty)"
      }`,
    );
  }
  if (!toVersion || !known.has(toVersion)) {
    throw new Error(
      `adopt: unknown "to" version ${JSON.stringify(to ?? null)}. Registry: ${
        registryVersions.join(", ") || "(empty)"
      }`,
    );
  }
  if (compareVersions(fromVersion, toVersion) > 0) {
    throw new Error(`adopt: "from" (${fromVersion}) is above "to" (${toVersion})`);
  }

  const currentDatabase = await adapter.currentDatabaseName(db);
  if (currentDatabase !== confirmDatabase) {
    throw new Error(
      `adopt: --confirm-database mismatch: connected to ${JSON.stringify(
        currentDatabase,
      )}, expected ${JSON.stringify(confirmDatabase)} — a stale DATABASE_URL must never adopt the wrong database`,
    );
  }

  if (!(await adapter.hasAnyTableInDefaultSchema(db))) {
    throw new Error(
      "adopt: the target database has no tables in its default schema — there is no schema to adopt; run migrate instead",
    );
  }

  const appliedVersions = await adapter.readAppliedVersions(db, config);
  let rangeStart = fromVersion;
  if (appliedVersions.size > 0) {
    const highest = [...appliedVersions].sort(compareVersions).at(-1);
    if (highest === undefined) {
      throw new Error("adopt: internal error: versions table reported rows but none were readable");
    }
    if (!force) {
      throw new Error(
        `adopt: the versions table already has rows (highest recorded: ${highest}). Re-run with force to continue adopting versions above ${highest}.`,
      );
    }
    if (compareVersions(toVersion, highest) <= 0) {
      config.logger.info(
        `drizzle-migrator: nothing to adopt — "to" (${toVersion}) is not above the highest recorded version (${highest})`,
      );
      return {
        adopted: [],
        notAdopted: registryVersions.filter((version) => compareVersions(version, toVersion) > 0),
      };
    }
    rangeStart =
      registryVersions.find((version) => compareVersions(version, highest) > 0) ?? toVersion;
  }

  const adopted: string[] = [];
  for (const migration of sorted) {
    if (compareVersions(migration.version, rangeStart) < 0) {
      continue;
    }
    if (compareVersions(migration.version, toVersion) > 0) {
      break;
    }
    await adapter.recordVersion(db, config, {
      version: migration.version,
      name: migration.name,
      origin: "adopted",
    });
    await adapter.appendLog(db, config, {
      id: randomUUID(),
      kind: "run.adopted",
      version: migration.version,
      payload: { name: migration.name, origin: "adopted" },
    });
    adopted.push(migration.version);
  }

  return {
    adopted,
    notAdopted: registryVersions.filter((version) => compareVersions(version, toVersion) > 0),
  };
}

export async function getStatus<TDb, TTx>(options: StatusOptions<TDb, TTx>): Promise<StatusReport> {
  const { db, adapter, config, migrations } = options;
  const sorted = sortMigrations(migrations);

  const appliedRows = await adapter.listAppliedVersionRows(db, config);
  const appliedVersions = new Set(appliedRows.map((row) => row.version));
  const currentVersion =
    appliedRows
      .map((row) => row.version)
      .sort(compareVersions)
      .at(-1) ?? null;
  const applied = [...appliedRows]
    .sort((a, b) => compareVersions(a.version, b.version))
    .map((row) => ({
      version: row.version,
      name: row.name,
      origin: row.origin,
      appliedAt: row.appliedAt,
    }));
  const pending = sorted
    .filter((migration) => !appliedVersions.has(migration.version))
    .map((migration) => ({ version: migration.version, name: migration.name }));
  const recentLogs = await adapter.readLogs(db, config, { limit: STATUS_RECENT_LOG_LIMIT });

  return { currentVersion, applied, pending, recentLogs };
}
