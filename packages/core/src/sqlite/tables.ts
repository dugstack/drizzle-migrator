import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ResolvedConfig } from "../core/config.js";

/** ISO-8601 wall-clock text: lexicographic order matches chronological order. */
export const NOW_ISO = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export function createTrackingTables(config: ResolvedConfig) {
  const versions = sqliteTable(config.tables.versions, {
    version: text("version").primaryKey(),
    name: text("name").notNull(),
    origin: text("origin").notNull().default("executed"),
    appliedAt: text("applied_at").notNull().default(NOW_ISO),
  });

  const logs = sqliteTable(
    config.tables.logs,
    {
      id: text("id").primaryKey(),
      at: text("at").notNull().default(NOW_ISO),
      kind: text("kind").notNull(),
      version: text("version"),
      runId: text("run_id"),
      payload: text("payload", { mode: "json" }),
      detail: text("detail"),
    },
    (table) => [
      index(`${config.tables.logs}_kind_idx`).on(table.kind),
      index(`${config.tables.logs}_version_idx`).on(table.version),
    ],
  );

  return { versions, logs };
}
