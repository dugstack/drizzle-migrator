import type { DialectAdapter } from "../core/adapter.js";
import { type SqliteDatabase, type SqliteTransaction, createSqliteAdapter } from "./adapter.js";

export type SqliteDialect = DialectAdapter<SqliteDatabase, SqliteTransaction>;

/** SQLite adapter token consumed by createMigrator. */
export const sqliteDialect: SqliteDialect = createSqliteAdapter();

export { createSqliteAdapter };
export type { SqliteDatabase, SqliteTransaction };
