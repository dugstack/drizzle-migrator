import type { DialectAdapter } from "../core/adapter.js";

export type MysqlDialect = DialectAdapter<never, never>;

const notImplemented = (): never => {
  throw new Error("mysql adapter is not implemented in v1");
};

/** Import-safe MySQL token. Every operation fails at first use. */
export const mysqlDialect: MysqlDialect = {
  id: "mysql",
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
