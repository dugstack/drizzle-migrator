import type { AuditLogEntry } from "./audit.js";
import type { ResolvedConfig } from "./config.js";

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
  recordVersion(
    db: TDb,
    config: ResolvedConfig,
    entry: { version: string; name: string; origin: "executed" | "adopted" },
  ): Promise<void>;
  appendLog(db: TDb, config: ResolvedConfig, entry: AuditLogEntry): Promise<void>;

  runInTransaction(db: TDb, fn: (tx: TTx) => Promise<void>): Promise<void>;
  executeRaw(tx: TTx, statement: string): Promise<void>;
}
