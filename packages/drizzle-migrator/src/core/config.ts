const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

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

function checkPath(field: string, value: string | undefined, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`"${field}" must be a non-empty string path`);
    return;
  }
  if (value.includes("\0")) {
    errors.push(`"${field}" must not contain null bytes`);
  }
  if (URL_PATTERN.test(value)) {
    errors.push(
      `"${field}" must be an absolute filesystem path or a path relative to process.cwd(), not a URL`,
    );
  }
}

function checkIdentifierField(field: string, value: string | undefined, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    errors.push(
      `"${field}" must be an identifier matching ${IDENTIFIER_PATTERN.source}, got ${JSON.stringify(value)}`,
    );
  }
}

export function defineConfig(config: MigratorConfigInput): MigratorConfig {
  const errors: string[] = [];

  if (typeof config.lockName !== "string" || config.lockName.length === 0) {
    errors.push(`"lockName" is required and must be a non-empty string`);
  }
  checkPath("sqlDir", config.sqlDir, errors);
  checkPath("migrationsDir", config.migrationsDir, errors);
  checkIdentifierField("schema", config.schema, errors);
  checkIdentifierField("tables.versions", config.tables?.versions, errors);
  checkIdentifierField("tables.logs", config.tables?.logs, errors);

  if (config.logger !== undefined) {
    const logger = config.logger;
    if (typeof logger.info !== "function" || typeof logger.error !== "function") {
      errors.push(`"logger" must be an object with info(...) and error(...) functions`);
    }
  }

  if (config.lock !== undefined) {
    const { waitTimeoutMs, retryIntervalMs } = config.lock;
    if (waitTimeoutMs !== undefined && (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs <= 0)) {
      errors.push(`"lock.waitTimeoutMs" must be a positive integer, got ${String(waitTimeoutMs)}`);
    }
    if (
      retryIntervalMs !== undefined &&
      (!Number.isInteger(retryIntervalMs) || retryIntervalMs < 0)
    ) {
      errors.push(
        `"lock.retryIntervalMs" must be a non-negative integer, got ${String(retryIntervalMs)}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`invalid migrator config:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

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
