import type { DialectAdapter } from "../core/adapter.js";

export type SqliteDialect = DialectAdapter<never, never>;

const notImplemented = (): never => {
  throw new Error("sqlite adapter is not implemented in v1");
};

/** Import-safe SQLite token. Every operation fails at first use. */
export const sqliteDialect: SqliteDialect = {
  id: "sqlite",
  quoteIdentifier: notImplemented,
  currentDatabaseName: notImplemented,
  acquireLock: notImplemented,
  releaseLock: notImplemented,
  bootstrapTrackingTables: notImplemented,
  readAppliedVersions: notImplemented,
  listAppliedVersionRows: notImplemented,
  recordVersion: notImplemented,
  appendLog: notImplemented,
  readLogs: notImplemented,
  hasAnyTableInDefaultSchema: notImplemented,
  runInTransaction: notImplemented,
  executeRaw: notImplemented,
};
