import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/mysql-core";
import type { ResolvedConfig } from "../core/config.js";
import type { MysqlDatabase } from "./adapter.js";
import { queryRows } from "./query.js";
import { quoteIdentifier } from "./quote.js";
import { createTrackingTables } from "./tables.js";

/**
 * MySQL has no schemas: `config.schema` only participates in identifier
 * validation, and tracking tables live in the database the connection
 * selects — the engine requires a dedicated migration database the same way
 * pg expects its tracking schema.
 */
export async function bootstrapTrackingTables(
  db: MysqlDatabase,
  config: ResolvedConfig,
): Promise<void> {
  const versionsTable = quoteIdentifier(config.tables.versions);
  const logsTable = quoteIdentifier(config.tables.logs);
  const column = (name: string) => quoteIdentifier(name);

  const statements = [
    `CREATE TABLE IF NOT EXISTS ${versionsTable} (
  ${column("version")} varchar(255) PRIMARY KEY NOT NULL,
  ${column("name")} varchar(255) NOT NULL,
  ${column("origin")} varchar(32) NOT NULL DEFAULT 'executed',
  ${column("applied_at")} timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
)`,
    `CREATE TABLE IF NOT EXISTS ${logsTable} (
  ${column("id")} varchar(36) PRIMARY KEY NOT NULL,
  ${column("at")} timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ${column("kind")} varchar(255) NOT NULL,
  ${column("version")} varchar(255),
  ${column("run_id")} varchar(36),
  ${column("payload")} json,
  ${column("detail")} text
)`,
  ];

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }

  const indexTargets = [
    { name: `${config.tables.logs}_kind_idx`, column: "kind" },
    { name: `${config.tables.logs}_version_idx`, column: "version" },
  ];
  for (const target of indexTargets) {
    // MySQL has no CREATE INDEX IF NOT EXISTS: check first, and tolerate the
    // duplicate-index error a concurrent bootstrap can still win.
    if (await indexExists(db, config.tables.logs, target.name)) {
      continue;
    }
    try {
      await db.execute(
        sql.raw(
          `CREATE INDEX ${quoteIdentifier(target.name)} ON ${logsTable} (${column(target.column)})`,
        ),
      );
    } catch (error) {
      if (!isDuplicateIndexError(error)) {
        throw error;
      }
    }
  }

  await assertNoTrackingDrift(db, config);
}

function isDuplicateIndexError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ER_DUP_KEYNAME"
  );
}

async function indexExists(
  db: MysqlDatabase,
  tableName: string,
  indexName: string,
): Promise<boolean> {
  const rows = await queryRows<{ present: number }>(
    db,
    sql`SELECT 1 AS present FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ${tableName} AND index_name = ${indexName} LIMIT 1`,
  );
  return rows.length > 0;
}

async function assertNoTrackingDrift(db: MysqlDatabase, config: ResolvedConfig): Promise<void> {
  const rows = await queryRows<{ table_name: string; column_name: string }>(
    db,
    sql`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name IN (${config.tables.versions}, ${config.tables.logs})`,
  );

  const physical = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = physical.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    physical.set(row.table_name, columns);
  }

  const tables = createTrackingTables(config);
  for (const table of [tables.versions, tables.logs]) {
    const tableConfig = getTableConfig(table);
    const declared = tableConfig.columns.map((column) => column.name);
    const physicalColumns = physical.get(tableConfig.name);

    if (!physicalColumns) {
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
