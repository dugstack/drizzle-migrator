export type MigratorLogger = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type MigratorTablesConfig = {
  versions: string;
  logs: string;
};

export type MigratorLockConfig = {
  waitTimeoutMs: number;
  retryIntervalMs: number;
};

export type MigratorConfigInput = {
  sqlDir?: string;
  migrationsDir?: string;
  schema?: string;
  tables?: Partial<MigratorTablesConfig>;
  lockName: string;
  lock?: Partial<MigratorLockConfig>;
  logger?: MigratorLogger;
};

export type ResolvedConfig = {
  sqlDir: string;
  migrationsDir: string;
  schema: string;
  tables: MigratorTablesConfig;
  lockName: string;
  lock: MigratorLockConfig;
  logger: MigratorLogger;
};

export type MigratorConfig = ResolvedConfig;

export function defineConfig(config: MigratorConfigInput): MigratorConfig {
  return {
    sqlDir: config.sqlDir ?? "./drizzle",
    migrationsDir: config.migrationsDir ?? "./migrations",
    schema: config.schema ?? "migrations",
    tables: {
      versions: config.tables?.versions ?? "migration_versions",
      logs: config.tables?.logs ?? "migration_logs",
    },
    lockName: config.lockName,
    lock: {
      waitTimeoutMs: config.lock?.waitTimeoutMs ?? 600_000,
      retryIntervalMs: config.lock?.retryIntervalMs ?? 5_000,
    },
    logger: config.logger ?? console,
  };
}
