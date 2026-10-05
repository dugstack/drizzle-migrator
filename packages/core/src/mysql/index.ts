import type { DialectAdapter } from "../core/adapter.js";
import { type MysqlDatabase, type MysqlTransaction, createMysqlAdapter } from "./adapter.js";

export type MysqlDialect = DialectAdapter<MysqlDatabase, MysqlTransaction>;

/** MySQL adapter token consumed by createMigrator. */
export const mysqlDialect: MysqlDialect = createMysqlAdapter();

export { createMysqlAdapter };
export type { MysqlDatabase, MysqlTransaction };
