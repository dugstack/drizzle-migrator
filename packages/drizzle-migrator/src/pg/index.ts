import type { DialectAdapter } from "../core/adapter.js";
import { type PgDatabase, type PgTransaction, createPgAdapter } from "./adapter.js";

export type PgDialect = DialectAdapter<PgDatabase, PgTransaction>;

/** PostgreSQL adapter token consumed by createMigrator. */
export const pgDialect: PgDialect = createPgAdapter();
