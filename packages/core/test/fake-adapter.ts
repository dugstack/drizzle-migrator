import type { DialectAdapter } from "../src/core/adapter.js";
import type { AuditLogEntry, RecentLogRow } from "../src/core/audit.js";
import type { MigrationOrigin } from "../src/core/result.js";

export type FakeVersionRow = {
  version: string;
  name: string;
  origin: MigrationOrigin;
  appliedAt: string;
};

export type FakeDatabase = {
  databaseName: string | null;
  defaultSchemaTables: string[];
  versions: FakeVersionRow[];
  logs: AuditLogEntry[];
  locked: boolean;
  lockShouldFail: boolean;
  failingStatement?: string;
  executedStatements: string[];
};

export type FakeTransaction = {
  stagedVersions: FakeVersionRow[];
  stagedLogs: AuditLogEntry[];
  stagedStatements: string[];
};

export type FakeLogger = {
  lines: string[];
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export function createFakeDatabase(overrides: Partial<FakeDatabase> = {}): FakeDatabase {
  return {
    databaseName: "fake_db",
    defaultSchemaTables: ["users"],
    versions: [],
    logs: [],
    locked: false,
    lockShouldFail: false,
    executedStatements: [],
    ...overrides,
  };
}

export function createFakeLogger(): FakeLogger {
  const lines: string[] = [];
  return {
    lines,
    info: (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    },
    error: (...args: unknown[]) => {
      lines.push(`ERROR: ${args.map((arg) => String(arg)).join(" ")}`);
    },
  };
}

function isTransaction(target: FakeDatabase | FakeTransaction): target is FakeTransaction {
  return "stagedVersions" in target;
}

export function createFakeAdapter(db: FakeDatabase): DialectAdapter<FakeDatabase, FakeTransaction> {
  return {
    id: "pg",

    quoteIdentifier: (identifier) => `"${identifier}"`,
    currentDatabaseName: async () => db.databaseName,

    acquireLock: async () => {
      if (db.lockShouldFail) {
        throw new Error("lock wait timed out (fake)");
      }
      db.locked = true;
    },
    releaseLock: async () => {
      db.locked = false;
    },

    bootstrapTrackingTables: async () => {
      if (!db.defaultSchemaTables.includes("migration_versions")) {
        db.defaultSchemaTables.push("migration_versions", "migration_logs");
      }
    },
    readAppliedVersions: async () => new Set(db.versions.map((row) => row.version)),
    listAppliedVersionRows: async () => [...db.versions],
    recordVersion: async (target, _config, entry) => {
      const row: FakeVersionRow = { ...entry, appliedAt: new Date().toISOString() };
      if (isTransaction(target)) {
        target.stagedVersions.push(row);
      } else {
        db.versions.push(row);
      }
    },
    appendLog: async (target, _config, entry) => {
      const logged: AuditLogEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
      if (isTransaction(target)) {
        target.stagedLogs.push(logged);
      } else {
        db.logs.push(logged);
      }
    },
    readLogs: async (_db, _config, opts): Promise<RecentLogRow[]> => {
      const tail = opts.limit > 0 ? db.logs.slice(-opts.limit) : [];
      return tail
        .slice()
        .reverse()
        .map((entry) => ({
          at: entry.at ?? "",
          kind: entry.kind,
          version: entry.version ?? null,
          detail: entry.detail ?? null,
        }));
    },
    hasAnyTableInDefaultSchema: async () => db.defaultSchemaTables.length > 0,

    runInTransaction: async (_db, fn) => {
      const tx: FakeTransaction = { stagedVersions: [], stagedLogs: [], stagedStatements: [] };
      await fn(tx);
      db.versions.push(...tx.stagedVersions);
      db.logs.push(...tx.stagedLogs);
      db.executedStatements.push(...tx.stagedStatements);
    },
    executeRaw: async (tx, statement) => {
      if (db.failingStatement !== undefined && statement.includes(db.failingStatement)) {
        throw new Error(`fake executeRaw failed: ${statement}`);
      }
      tx.stagedStatements.push(statement);
    },
  };
}
