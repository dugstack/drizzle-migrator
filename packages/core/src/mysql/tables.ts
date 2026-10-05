import { index, json, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
import type { ResolvedConfig } from "../core/config.js";

/**
 * MySQL has no `text` primary keys, so tracking identifiers are varchar-backed.
 * The lengths here are mirrored by the bootstrap DDL in ./bootstrap.ts — the
 * two files must be edited together (the drift assertion compares column
 * names only, keeping them in sync is on these definitions).
 */
export function createTrackingTables(config: ResolvedConfig) {
  const versions = mysqlTable(config.tables.versions, {
    version: varchar("version", { length: 255 }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    origin: varchar("origin", { length: 32 }).notNull().default("executed"),
    appliedAt: timestamp("applied_at", { fsp: 3 }).notNull().defaultNow(),
  });

  const logs = mysqlTable(
    config.tables.logs,
    {
      id: varchar("id", { length: 36 }).primaryKey(),
      at: timestamp("at", { fsp: 3 }).notNull().defaultNow(),
      kind: varchar("kind", { length: 255 }).notNull(),
      version: varchar("version", { length: 255 }),
      runId: varchar("run_id", { length: 36 }),
      payload: json("payload"),
      detail: text("detail"),
    },
    (table) => [
      index(`${config.tables.logs}_kind_idx`).on(table.kind),
      index(`${config.tables.logs}_version_idx`).on(table.version),
    ],
  );

  return { versions, logs };
}
