import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "better-sqlite3";
import { desc, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DialectAdapter } from "../core/adapter.js";
import type { RecentLogRow } from "../core/audit.js";
import type { MigrationOrigin } from "../core/result.js";
import { bootstrapTrackingTables } from "./bootstrap.js";
import { createTrackingTables } from "./tables.js";

/**
 * What the `drizzle(client)` factory returns for better-sqlite3: the query
 * builder plus the underlying driver handle under `$client`, which this
 * adapter uses for PRAGMAs and transaction control.
 */
export type SqliteDatabase = BetterSQLite3Database<Record<string, never>> & { $client: Database };
/**
 * SQLite executes everything on one connection, so a migration's transaction
 * handle is the same drizzle instance: statements issued through it join the
 * savepoint (or lock transaction) currently open on the connection.
 */
export type SqliteTransaction = SqliteDatabase;

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const SQLITE_BUSY = "SQLITE_BUSY";

function isBusyError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    if ((error as { code?: unknown }).code === SQLITE_BUSY) {
      return true;
    }
  }
  return error instanceof Error && /database is locked/.test(error.message);
}

let savepointCounter = 0;

/**
 * Builds the SQLite dialect adapter over `drizzle-orm/better-sqlite3`.
 *
 * Locking: SQLite has no advisory locks, so `acquireLock` opens a
 * `BEGIN IMMEDIATE` transaction on the connection and holds it open — the
 * database file's single-writer rule is the cross-process lock. `lockName`
 * only appears in diagnostics. `releaseLock` commits that transaction, which
 * also publishes the whole run (tracking rows included) atomically; if the
 * process dies first, SQLite's journal rollback leaves nothing applied and
 * nothing recorded. `runInTransaction` therefore nests via SAVEPOINTs so the
 * engine's per-migration transactions work inside the held lock.
 */
export function createSqliteAdapter(): DialectAdapter<SqliteDatabase, SqliteTransaction> {
  return {
    id: "sqlite",

    quoteIdentifier(identifier) {
      if (!IDENTIFIER_PATTERN.test(identifier)) {
        throw new Error(
          `invalid identifier ${JSON.stringify(identifier)}: must match ${IDENTIFIER_PATTERN.source}`,
        );
      }
      return `"${identifier}"`;
    },

    /** The main database file path, or null for in-memory databases. */
    async currentDatabaseName(db) {
      const rows = db.$client.pragma("database_list") as Array<{
        name: string;
        file: string;
      }>;
      const main = rows.find((row) => row.name === "main");
      return main?.file ? main.file : null;
    },

    async acquireLock(db, lockName, opts) {
      const client = db.$client;
      const priorBusyTimeout = client.pragma("busy_timeout", { simple: true }) as number;
      client.pragma(`busy_timeout = ${opts.retryIntervalMs}`);
      const deadline = Date.now() + opts.waitTimeoutMs;
      try {
        for (;;) {
          try {
            client.exec("BEGIN IMMEDIATE");
            return;
          } catch (error) {
            if (!isBusyError(error)) {
              throw error;
            }
            if (Date.now() >= deadline) {
              throw new Error(
                `could not acquire the sqlite write lock ${JSON.stringify(
                  lockName,
                )} within ${opts.waitTimeoutMs}ms — the database file is locked by another writer`,
              );
            }
            await sleep(opts.retryIntervalMs);
          }
        }
      } finally {
        client.pragma(`busy_timeout = ${priorBusyTimeout}`);
      }
    },

    async releaseLock(db, lockName) {
      const client = db.$client;
      if (!client.inTransaction) {
        return;
      }
      try {
        client.exec("COMMIT");
      } catch (error) {
        throw new Error(`failed to release the sqlite write lock ${JSON.stringify(lockName)}`, {
          cause: error,
        });
      }
    },

    async bootstrapTrackingTables(db, config) {
      await bootstrapTrackingTables(db, config);
    },

    async readAppliedVersions(db, config) {
      const { versions } = createTrackingTables(config);
      const rows = await db.select({ version: versions.version }).from(versions);
      return new Set(rows.map((row) => row.version));
    },

    async listAppliedVersionRows(db, config) {
      const { versions } = createTrackingTables(config);
      const rows = await db
        .select({
          version: versions.version,
          name: versions.name,
          origin: versions.origin,
          appliedAt: versions.appliedAt,
        })
        .from(versions);
      return rows.map((row) => ({
        version: row.version,
        name: row.name,
        origin: row.origin as MigrationOrigin,
        appliedAt: new Date(row.appliedAt).toISOString(),
      }));
    },

    async recordVersion(db, config, entry) {
      const { versions } = createTrackingTables(config);
      await db.insert(versions).values({
        version: entry.version,
        name: entry.name,
        origin: entry.origin,
      });
    },

    async appendLog(db, config, entry) {
      const { logs } = createTrackingTables(config);
      await db.insert(logs).values({
        id: entry.id ?? randomUUID(),
        at: entry.at ? new Date(entry.at).toISOString() : undefined,
        kind: entry.kind,
        version: entry.version ?? null,
        runId: entry.runId ?? null,
        payload: entry.payload ?? null,
        detail: entry.detail ?? null,
      });
    },

    async readLogs(db, config, opts): Promise<RecentLogRow[]> {
      const { logs } = createTrackingTables(config);
      const rows = await db
        .select({ at: logs.at, kind: logs.kind, version: logs.version, detail: logs.detail })
        .from(logs)
        .orderBy(desc(logs.at))
        .limit(opts.limit);
      return rows.map((row) => ({
        at: new Date(row.at).toISOString(),
        kind: row.kind,
        version: row.version ?? null,
        detail: row.detail ?? null,
      }));
    },

    async hasAnyTableInDefaultSchema(db) {
      const rows = await db.all(
        sql`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`,
      );
      return rows.length > 0;
    },

    async runInTransaction(db, fn) {
      const client = db.$client;
      const savepoint = `dm_tx_${savepointCounter++}`;
      client.exec(`SAVEPOINT ${savepoint}`);
      try {
        await fn(db);
        client.exec(`RELEASE ${savepoint}`);
      } catch (error) {
        try {
          client.exec(`ROLLBACK TO ${savepoint}`);
          client.exec(`RELEASE ${savepoint}`);
        } catch {
          // The enclosing transaction is already aborted — surface the original failure.
        }
        throw error;
      }
    },

    async executeRaw(tx, statement) {
      await tx.run(sql.raw(statement));
    },
  };
}
