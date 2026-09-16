import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { ResolvedConfig } from "../core/config.js";
import { quoteIdentifier } from "./quote.js";
import { createTrackingTables } from "./tables.js";

export async function bootstrapTrackingTables(
  db: NodePgDatabase<Record<string, never>>,
  config: ResolvedConfig,
): Promise<void> {
  const schema = quoteIdentifier(config.schema);
  const versionsTable = quoteIdentifier(config.tables.versions);
  const logsTable = quoteIdentifier(config.tables.logs);
  const column = (name: string) => quoteIdentifier(name);

  const statements = [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE TABLE IF NOT EXISTS ${schema}.${versionsTable} (
  ${column("version")} text PRIMARY KEY NOT NULL,
  ${column("name")} text NOT NULL,
  ${column("origin")} text NOT NULL DEFAULT 'executed',
  ${column("applied_at")} timestamptz DEFAULT now() NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS ${schema}.${logsTable} (
  ${column("id")} uuid PRIMARY KEY NOT NULL,
  ${column("at")} timestamptz DEFAULT now() NOT NULL,
  ${column("kind")} text NOT NULL,
  ${column("version")} text,
  ${column("run_id")} uuid,
  ${column("payload")} jsonb,
  ${column("detail")} text
)`,
    `CREATE INDEX IF NOT EXISTS ${column(`${config.tables.logs}_kind_idx`)} ON ${schema}.${logsTable} (${column("kind")})`,
    `CREATE INDEX IF NOT EXISTS ${column(`${config.tables.logs}_version_idx`)} ON ${schema}.${logsTable} (${column("version")})`,
  ];

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }

  await assertNoTrackingDrift(db, config);
}

function qualifiedName(name: string, schema: string | undefined): string {
  return schema ? `${schema}.${name}` : name;
}

async function assertNoTrackingDrift(
  db: NodePgDatabase<Record<string, never>>,
  config: ResolvedConfig,
): Promise<void> {
  const { rows } = await db.execute(
    sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ${config.schema}`,
  );

  const physical = new Map<string, Set<string>>();
  for (const row of rows as Array<{ table_name: string | null; column_name: string }>) {
    if (!row.table_name) {
      continue;
    }
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
        `tracking table drift for ${qualifiedName(tableConfig.name, tableConfig.schema)}: no columns found in the database after bootstrap — the bootstrap DDL and the drizzle table definitions must be edited together`,
      );
    }

    const missing = declared.filter((name) => !physicalColumns.has(name));
    const undeclared = [...physicalColumns].filter((name) => !declared.includes(name));

    if (missing.length > 0 || undeclared.length > 0) {
      throw new Error(
        `tracking table drift for ${qualifiedName(tableConfig.name, tableConfig.schema)}: missing columns [${missing.join(", ")}], undeclared columns [${undeclared.join(", ")}] — the bootstrap DDL and the drizzle table definitions must be edited together`,
      );
    }
  }
}
