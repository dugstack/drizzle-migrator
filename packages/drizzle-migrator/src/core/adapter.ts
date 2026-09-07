import type { RecentLogRow } from "./audit.js";
import type { AuditLogEntry } from "./audit.js";
import type { ResolvedConfig } from "./config.js";
import type { AppliedVersionRow } from "./result.js";

export interface DialectAdapter<TDb = unknown, TTx = unknown> {
  readonly id: "pg" | "mysql" | "sqlite";

  quoteIdentifier(identifier: string): string;
  currentDatabaseName(db: TDb): Promise<string | null>;

  acquireLock(
    db: TDb,
    lockName: string,
    opts: { waitTimeoutMs: number; retryIntervalMs: number },
  ): Promise<void>;
  releaseLock(db: TDb, lockName: string): Promise<void>;

  bootstrapTrackingTables(db: TDb, config: ResolvedConfig): Promise<void>;
  readAppliedVersions(db: TDb, config: ResolvedConfig): Promise<Set<string>>;
  listAppliedVersionRows(db: TDb, config: ResolvedConfig): Promise<AppliedVersionRow[]>;
  recordVersion(
    db: TDb | TTx,
    config: ResolvedConfig,
    entry: { version: string; name: string; origin: "executed" | "adopted" },
  ): Promise<void>;
  appendLog(db: TDb | TTx, config: ResolvedConfig, entry: AuditLogEntry): Promise<void>;
  readLogs(db: TDb, config: ResolvedConfig, opts: { limit: number }): Promise<RecentLogRow[]>;
  hasAnyTableInDefaultSchema(db: TDb): Promise<boolean>;

  runInTransaction(db: TDb, fn: (tx: TTx) => Promise<void>): Promise<void>;
  executeRaw(tx: TTx, statement: string): Promise<void>;
}
