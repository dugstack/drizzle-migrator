import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { desc, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type { DialectAdapter } from "../core/adapter.js";
import type { RecentLogRow } from "../core/audit.js";
import type { MigrationOrigin } from "../core/result.js";
import { bootstrapTrackingTables } from "./bootstrap.js";
import { queryRows } from "./query.js";
import { createTrackingTables } from "./tables.js";

/**
 * What the `drizzle(client)` factory returns for mysql2: the query builder
 * over one session handle, which this adapter uses for locking and reads.
 */
export type MysqlDatabase = MySql2Database<Record<string, never>>;
export type MysqlTransaction = Parameters<Parameters<MysqlDatabase["transaction"]>[0]>[0];

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const GET_LOCK_ACQUIRED = 1;
const RELEASE_LOCK_RELEASED = 1;

/**
 * Builds the MySQL dialect adapter over `drizzle-orm/mysql2`.
 *
 * Locking: `acquireLock` polls `GET_LOCK(name, 0)` until the session holds the
 * advisory lock (MySQL named locks are session-scoped, not transaction-scoped,
 * so they survive the per-migration commits), and `releaseLock` calls
 * `RELEASE_LOCK` — a non-1 result means the session does not own the lock and
 * fails loudly. The lock lives on one server session, so the consumer must
 * pass drizzle over a single `mysql2` Connection, never a shared Pool: a Pool
 * would spread `GET_LOCK`, the migration statements, and `RELEASE_LOCK` across
 * connections and the run would neither hold the lock nor release it.
 *
 * Transactions: `runInTransaction` delegates to drizzle's `db.transaction`,
 * which InnoDB executes on the session. MySQL DDL implicitly commits: a
 * migration whose `up()` runs DDL is not atomic — executed statements persist
 * even if a later statement fails or the process dies. The engine's
 * `run.started` / `run.applied` audit rows are the reconstruction trail; the
 * next run re-derives pending state from the versions table.
 */
export function createMysqlAdapter(): DialectAdapter<MysqlDatabase, MysqlTransaction> {
  return {
    id: "mysql",

    quoteIdentifier(identifier) {
      if (!IDENTIFIER_PATTERN.test(identifier)) {
        throw new Error(
          `invalid identifier ${JSON.stringify(identifier)}: must match ${IDENTIFIER_PATTERN.source}`,
        );
      }
      return `\`${identifier}\``;
    },

    /** The connected database (null when the connection selected none). */
    async currentDatabaseName(db) {
      const rows = await queryRows<{ current_database: string | null }>(
        db,
        sql`SELECT DATABASE() AS current_database`,
      );
      return rows[0]?.current_database ?? null;
    },

    async acquireLock(db, lockName, opts) {
      const deadline = Date.now() + opts.waitTimeoutMs;
      for (;;) {
        const rows = await queryRows<{ locked: number | null }>(
          db,
          sql`SELECT GET_LOCK(${lockName}, 0) AS locked`,
        );
        const locked = rows[0]?.locked;
        if (locked === GET_LOCK_ACQUIRED) {
          return;
        }
        if (locked === null) {
          throw new Error(
            `mysql GET_LOCK errored while acquiring ${JSON.stringify(lockName)} (returned NULL)`,
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `could not acquire the advisory lock ${JSON.stringify(lockName)} within ${opts.waitTimeoutMs}ms`,
          );
        }
        await sleep(opts.retryIntervalMs);
      }
    },

    async releaseLock(db, lockName) {
      const rows = await queryRows<{ unlocked: number | null }>(
        db,
        sql`SELECT RELEASE_LOCK(${lockName}) AS unlocked`,
      );
      const unlocked = rows[0]?.unlocked;
      if (unlocked !== RELEASE_LOCK_RELEASED) {
        throw new Error(
          `failed to release the mysql advisory lock ${JSON.stringify(lockName)} (RELEASE_LOCK returned ${String(unlocked)} — the session does not own it)`,
        );
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
        appliedAt: row.appliedAt.toISOString(),
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
        at: entry.at ? new Date(entry.at) : undefined,
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
        at: row.at.toISOString(),
        kind: row.kind,
        version: row.version ?? null,
        detail: row.detail ?? null,
      }));
    },

    async hasAnyTableInDefaultSchema(db) {
      const rows = await queryRows<{ present: number }>(
        db,
        sql`SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' LIMIT 1`,
      );
      return rows.length > 0;
    },

    async runInTransaction(db, fn) {
      await db.transaction(async (tx) => fn(tx));
    },

    async executeRaw(tx, statement) {
      await tx.execute(sql.raw(statement));
    },
  };
}
