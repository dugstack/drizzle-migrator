import {
  type MigratorConfig,
  type MigratorLogger,
  defineConfig as defineCoreConfig,
} from "@dugstack/drizzle-migrator";

// Core keeps these internal; the resolved shapes are derivable from MigratorConfig.
export type MigratorTablesConfig = MigratorConfig["tables"];
export type MigratorLockConfig = MigratorConfig["lock"];

/** Mirrors the plan: `lockName` defaults to "drizzle-migrator" in the CLI config. */
export const DEFAULT_LOCK_NAME = "drizzle-migrator";

export type CliDialect = "postgres" | "mysql" | "sqlite";

export type PostgresCliConnection = {
  connectionString: string;
};

export type MysqlCliConnection = {
  connectionString: string;
};

export type SqliteCliConnection = {
  /** Path to the database file; ":memory:" keeps everything in process. */
  path: string;
};

/** Fields shared by every dialect member of the CLI config. */
type CliConfigBase = {
  /** Folder holding the migration entries; auto-discovery scans its v<semver>/index.ts folders. */
  migratorOutDir: string;
  /** drizzle-kit SQL output folder. Wins over the `out` field of drizzle.config.*. */
  drizzleOutDir?: string;
  /** Advisory-lock name; defaults to DEFAULT_LOCK_NAME. Never change after first deploy. */
  lockName?: string;
  /** Pass-through core config: tracking schema (pg) and table names. */
  schema?: string;
  tables?: Partial<MigratorTablesConfig>;
  lock?: Partial<MigratorLockConfig>;
  logger?: MigratorLogger;
};

/**
 * Discriminated by `dialect`; each dialect carries its own optional connection
 * block. Connection-free commands (`generate`, `validate`) run without it;
 * commands that need a database (`migrate`, `adopt`, `status`) fail before
 * execution when it is absent.
 */
export type PostgresCliConfigInput = CliConfigBase & {
  dialect: "postgres";
  postgres?: PostgresCliConnection;
};

export type MysqlCliConfigInput = CliConfigBase & {
  dialect: "mysql";
  mysql?: MysqlCliConnection;
};

export type SqliteCliConfigInput = CliConfigBase & {
  dialect: "sqlite";
  sqlite?: SqliteCliConnection;
};

export type MigratorCliConfigInput =
  | PostgresCliConfigInput
  | MysqlCliConfigInput
  | SqliteCliConfigInput;

type CliConfigResolvedBase = {
  migratorOutDir: string;
  drizzleOutDir: string | undefined;
  lockName: string;
  schema: string | undefined;
  tables: Partial<MigratorTablesConfig> | undefined;
  lock: Partial<MigratorLockConfig> | undefined;
  logger: MigratorLogger;
};

export type MigratorCliConfig =
  | ({ dialect: "postgres"; postgres: PostgresCliConnection | undefined } & CliConfigResolvedBase)
  | ({ dialect: "mysql"; mysql: MysqlCliConnection | undefined } & CliConfigResolvedBase)
  | ({ dialect: "sqlite"; sqlite: SqliteCliConnection | undefined } & CliConfigResolvedBase);

const PATH_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const CONNECTION_STRING_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
const POSTGRES_SCHEMES = new Set(["postgres", "postgresql"]);
const MYSQL_SCHEMES = new Set(["mysql", "mariadb"]);

function checkPath(field: string, value: unknown, errors: string[]): void {
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
  if (PATH_URL_PATTERN.test(value)) {
    errors.push(
      `"${field}" must be an absolute filesystem path or a path relative to process.cwd(), not a URL`,
    );
  }
}

/**
 * Validates the shape of a *provided* connection string. An absent or empty one
 * is not a config error — the connection is optional; commands that require a
 * database fail at run time with their own message. Returns true when a usable
 * string was validated.
 */
function checkConnectionString(
  field: string,
  value: unknown,
  schemes: ReadonlySet<string>,
  expected: string,
  fallbackHint: string | undefined,
  errors: string[],
): boolean {
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
    return false;
  }
  if (typeof value !== "string") {
    errors.push(`"${field}" must be a string when present`);
    return true;
  }
  const scheme = CONNECTION_STRING_SCHEME_PATTERN.exec(value)?.[1];
  if (scheme !== undefined) {
    const normalized = scheme.toLowerCase();
    if (!schemes.has(normalized)) {
      errors.push(`"${field}" URL scheme "${scheme}" is not ${expected} (expected ${expected}://)`);
    }
    return true;
  }
  if (fallbackHint !== undefined && !value.includes("=")) {
    errors.push(
      `"${field}" must be a ${expected}:// URL or a key=value connection string (e.g. "${fallbackHint}")`,
    );
  }
  return true;
}

function readConnectionBlock(
  raw: Record<string, unknown>,
  dialect: CliDialect,
  errors: string[],
): Record<string, unknown> | undefined {
  // A block for a different dialect is almost certainly a config typo; check
  // it before the dialect's own (possibly absent) block short-circuits.
  for (const other of ["postgres", "mysql", "sqlite"] as const) {
    if (other !== dialect && raw[other] !== undefined) {
      errors.push(
        `"${other}" connection block requires "dialect": "${other}" (the config declares "${dialect}")`,
      );
    }
  }
  const block = raw[dialect];
  if (block === undefined || block === null) {
    return undefined;
  }
  if (typeof block !== "object") {
    errors.push(
      `"${dialect}" must be an object${
        dialect === "sqlite" ? ' with a "path"' : ' with a "connectionString"'
      } when present`,
    );
    return undefined;
  }
  return block as Record<string, unknown>;
}

/**
 * Validates a loaded (or authored) CLI config. `defineConfig` is sugar over this
 * for authoring; the runner re-validates whatever a config file actually exports,
 * so a plain-object default export works too.
 */
export function resolveCliConfig(input: unknown): MigratorCliConfig {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null) {
    throw new Error(
      "invalid migrator CLI config: expected an object (the default export of drizzle-migrator.config.ts)",
    );
  }
  const raw = input as Record<string, unknown>;

  const dialect = raw.dialect;
  if (dialect !== "postgres" && dialect !== "mysql" && dialect !== "sqlite") {
    errors.push(
      `"dialect" must be one of "postgres", "mysql", "sqlite" (got ${JSON.stringify(dialect) ?? "undefined"})`,
    );
    throw new Error(
      `invalid migrator CLI config:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  const connectionBlock = readConnectionBlock(raw, dialect, errors);

  let postgres: PostgresCliConnection | undefined;
  let mysql: MysqlCliConnection | undefined;
  let sqlite: SqliteCliConnection | undefined;

  if (dialect === "postgres" && connectionBlock !== undefined) {
    if (
      checkConnectionString(
        "postgres.connectionString",
        connectionBlock.connectionString,
        POSTGRES_SCHEMES,
        "postgres",
        "host=localhost dbname=app",
        errors,
      ) &&
      typeof connectionBlock.connectionString === "string"
    ) {
      postgres = { connectionString: connectionBlock.connectionString };
    }
  }

  if (dialect === "mysql" && connectionBlock !== undefined) {
    if (
      checkConnectionString(
        "mysql.connectionString",
        connectionBlock.connectionString,
        MYSQL_SCHEMES,
        "mysql",
        undefined,
        errors,
      ) &&
      typeof connectionBlock.connectionString === "string"
    ) {
      mysql = { connectionString: connectionBlock.connectionString };
    }
  }

  if (dialect === "sqlite" && connectionBlock !== undefined) {
    const path = connectionBlock.path;
    if (path === undefined || (typeof path === "string" && path.trim().length === 0)) {
      // Absent path behaves like the URL-based dialects: an empty block resolves
      // to no connection so connection-free commands keep working.
    } else if (typeof path === "string") {
      checkPath("sqlite.path", path, errors);
      sqlite = { path };
    } else {
      errors.push(`"sqlite.path" must be a string when present`);
    }
  }

  if (typeof raw.migratorOutDir !== "string" || (raw.migratorOutDir as string).length === 0) {
    errors.push(`"migratorOutDir" is required and must be a non-empty string path`);
  }
  checkPath("drizzleOutDir", raw.drizzleOutDir, errors);
  if (
    raw.lockName !== undefined &&
    (typeof raw.lockName !== "string" || (raw.lockName as string).length === 0)
  ) {
    errors.push(`"lockName" must be a non-empty string`);
  }

  if (errors.length > 0) {
    throw new Error(
      `invalid migrator CLI config:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  // schema/tables/lock/logger pass through unchanged; defineCoreConfig validates them.
  const resolvedBase: CliConfigResolvedBase = {
    migratorOutDir: raw.migratorOutDir as string,
    drizzleOutDir: raw.drizzleOutDir as string | undefined,
    lockName: (raw.lockName as string | undefined) ?? DEFAULT_LOCK_NAME,
    schema: raw.schema as string | undefined,
    tables: raw.tables as Partial<MigratorTablesConfig> | undefined,
    lock: raw.lock as Partial<MigratorLockConfig> | undefined,
    logger: (raw.logger as MigratorLogger | undefined) ?? console,
  };

  if (dialect === "mysql") {
    return { dialect, mysql, ...resolvedBase };
  }
  if (dialect === "sqlite") {
    return { dialect, sqlite, ...resolvedBase };
  }
  return { dialect: "postgres", postgres, ...resolvedBase };
}

/** The resolved config member matching a given dialect literal. */
type ResolvedFor<D extends CliDialect> = Extract<MigratorCliConfig, { dialect: D }>;

/** Authoring-time sugar with full type checking; identical validation to the runner. */
export function defineConfig<T extends MigratorCliConfigInput>(
  input: T,
): ResolvedFor<T["dialect"]> {
  return resolveCliConfig(input) as ResolvedFor<T["dialect"]>;
}

/** Builds the core MigratorConfig once the drizzle SQL directory is resolved. */
export function toCoreConfig(cli: MigratorCliConfig, sqlDir: string): MigratorConfig {
  return defineCoreConfig({
    sqlDir,
    migrationsDir: cli.migratorOutDir,
    schema: cli.schema,
    tables: cli.tables,
    lock: cli.lock,
    lockName: cli.lockName,
    logger: cli.logger,
  });
}
