import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { ResolvedConfig } from "../core/config.js";
import type { SqliteDatabase } from "./adapter.js";
import { quoteIdentifier } from "./quote.js";
import { createTrackingTables } from "./tables.js";

/**
 * SQLite has no schemas: `config.schema` only participates in identifier
 * validation, and tracking tables live at the top level of the database file.
 */
export async function bootstrapTrackingTables(
  db: SqliteDatabase,
  config: ResolvedConfig,
): Promise<void> {
  const versionsTable = quoteIdentifier(config.tables.versions);
  const logsTable = quoteIdentifier(config.tables.logs);
  const column = (name: string) => quoteIdentifier(name);
  const nowIso = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

  const statements = [
    `CREATE TABLE IF NOT EXISTS ${versionsTable} (
  ${column("version")} text PRIMARY KEY NOT NULL,
  ${column("name")} text NOT NULL,
  ${column("origin")} text NOT NULL DEFAULT 'executed',
  ${column("applied_at")} text NOT NULL DEFAULT (${nowIso})
)`,
    `CREATE TABLE IF NOT EXISTS ${logsTable} (
  ${column("id")} text PRIMARY KEY NOT NULL,
  ${column("at")} text NOT NULL DEFAULT (${nowIso}),
  ${column("kind")} text NOT NULL,
  ${column("version")} text,
  ${column("run_id")} text,
  ${column("payload")} text,
  ${column("detail")} text
)`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${config.tables.logs}_kind_idx`)} ON ${logsTable} (${column("kind")})`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${config.tables.logs}_version_idx`)} ON ${logsTable} (${column("version")})`,
  ];

  for (const statement of statements) {
    await db.run(sql.raw(statement));
  }

  await assertNoTrackingDrift(db, config);
}

async function assertNoTrackingDrift(db: SqliteDatabase, config: ResolvedConfig): Promise<void> {
  const tables = createTrackingTables(config);
  for (const table of [tables.versions, tables.logs]) {
    const tableConfig = getTableConfig(table);
    const declared = tableConfig.columns.map((column) => column.name);
    const rows = db.$client.pragma(`table_info(${quoteIdentifier(tableConfig.name)})`) as Array<{
      name: string;
    }>;
    const physicalColumns = new Set(rows.map((row) => row.name));

    if (physicalColumns.size === 0) {
      throw new Error(
        `tracking table drift for ${tableConfig.name}: no columns found in the database after bootstrap — the bootstrap DDL and the drizzle table definitions must be edited together`,
      );
    }

    const missing = declared.filter((name) => !physicalColumns.has(name));
    const undeclared = [...physicalColumns].filter((name) => !declared.includes(name));

    if (missing.length > 0 || undeclared.length > 0) {
      throw new Error(
        `tracking table drift for ${tableConfig.name}: missing columns [${missing.join(", ")}], undeclared columns [${undeclared.join(", ")}] — the bootstrap DDL and the drizzle table definitions must be edited together`,
      );
    }
  }
}
