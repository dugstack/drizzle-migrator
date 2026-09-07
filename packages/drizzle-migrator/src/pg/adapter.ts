import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DialectAdapter } from "../core/adapter.js";
import type { RecentLogRow } from "../core/audit.js";
import type { MigrationOrigin } from "../core/result.js";
import { bootstrapTrackingTables as bootstrapTables } from "./bootstrap.js";
import { createTrackingTables } from "./tables.js";

export type PgDatabase = NodePgDatabase<Record<string, never>>;
export type PgTransaction = Parameters<Parameters<PgDatabase["transaction"]>[0]>[0];

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

export function createPgAdapter(): DialectAdapter<PgDatabase, PgTransaction> {
  return {
    id: "pg",

    quoteIdentifier(identifier) {
      if (!IDENTIFIER_PATTERN.test(identifier)) {
        throw new Error(
          `invalid identifier ${JSON.stringify(identifier)}: must match ${IDENTIFIER_PATTERN.source}`,
        );
      }
      return `"${identifier}"`;
    },

    async currentDatabaseName(db) {
      const { rows } = await db.execute(sql`SELECT current_database() AS current_database`);
      const row = rows[0] as { current_database: string | null } | undefined;
      return row?.current_database ?? null;
    },

    async acquireLock(db, lockName, opts) {
      const deadline = Date.now() + opts.waitTimeoutMs;
      for (;;) {
        const { rows } = await db.execute(
          sql`SELECT pg_try_advisory_lock(hashtext(${lockName})) AS locked`,
        );
        const locked = (rows[0] as { locked: boolean } | undefined)?.locked;
        if (locked === true) {
          return;
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
      await db.execute(sql`SELECT pg_advisory_unlock(hashtext(${lockName})) AS unlocked`);
    },

    async bootstrapTrackingTables(db, config) {
      await bootstrapTables(db, config);
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
      const { rows } = await db.execute(
        sql`SELECT 1 AS present FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' LIMIT 1`,
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
