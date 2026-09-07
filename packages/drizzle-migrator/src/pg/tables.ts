import { index, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { ResolvedConfig } from "../core/config.js";

export function createTrackingTables(config: ResolvedConfig) {
  const schema = pgSchema(config.schema);

  const versions = schema.table(config.tables.versions, {
    version: text("version").primaryKey(),
    name: text("name").notNull(),
    origin: text("origin").notNull().default("executed"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  });

  const logs = schema.table(
    config.tables.logs,
    {
      id: uuid("id").primaryKey(),
      at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
      kind: text("kind").notNull(),
      version: text("version"),
      runId: uuid("run_id"),
      payload: jsonb("payload"),
      detail: text("detail"),
    },
    (table) => [
      index(`${config.tables.logs}_kind_idx`).on(table.kind),
      index(`${config.tables.logs}_version_idx`).on(table.version),
    ],
  );

  return { versions, logs };
}
