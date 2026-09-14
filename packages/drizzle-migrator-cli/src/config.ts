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

export type PostgresCliConnection = {
  connectionString: string;
};

/**
 * Discriminated by `dialect`. v1 ships the postgres member only; future dialects
 * join as additional union members behind their own connection block.
 */
export type MigratorCliConfigInput = PostgresCliConfigInput;

export type PostgresCliConfigInput = {
  dialect: "postgres";
  /**
   * Optional since Revision 3: connection-free commands (`generate`, `validate`)
   * run without it; commands that need a database (`migrate`, `adopt`, `status`)
   * fail before execution when it is absent.
   */
  postgres?: PostgresCliConnection;
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

export type MigratorCliConfig = {
  dialect: "postgres";
  /** undefined when no usable connection string is configured (see resolveCliConfig). */
  postgres: PostgresCliConnection | undefined;
  migratorOutDir: string;
  drizzleOutDir: string | undefined;
  lockName: string;
  schema: string | undefined;
  tables: Partial<MigratorTablesConfig> | undefined;
  lock: Partial<MigratorLockConfig> | undefined;
  logger: MigratorLogger;
};

const PATH_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const CONNECTION_STRING_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

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
function checkConnectionString(value: unknown, errors: string[]): boolean {
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
    return false;
  }
  if (typeof value !== "string") {
    errors.push(`"postgres.connectionString" must be a string when present`);
    return true;
  }
  const scheme = CONNECTION_STRING_SCHEME_PATTERN.exec(value)?.[1];
  if (scheme !== undefined) {
    const normalized = scheme.toLowerCase();
    if (normalized !== "postgres" && normalized !== "postgresql") {
      errors.push(
        `"postgres.connectionString" URL scheme "${scheme}" is not postgres (expected postgres:// or postgresql://)`,
      );
    }
    return true;
  }
  if (!value.includes("=")) {
    errors.push(
      `"postgres.connectionString" must be a postgres:// URL or a key=value connection string (e.g. "host=localhost dbname=app")`,
    );
  }
  return true;
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

  if (raw.dialect !== "postgres") {
    errors.push(
      `"dialect" must be "postgres" (got ${JSON.stringify(raw.dialect) ?? "undefined"}); other dialects are not implemented yet`,
    );
  }

  // The postgres block is optional: absent, empty, or env-var-driven undefined
  // connection strings resolve to `postgres: undefined` so connection-free
  // commands (generate, validate) keep working; database commands then fail at
  // run time with a "requires a database" message instead of a config error.
  let postgres: PostgresCliConnection | undefined;
  if (raw.postgres !== undefined && raw.postgres !== null) {
    if (typeof raw.postgres !== "object") {
      errors.push(`"postgres" must be an object with a "connectionString" when present`);
    } else {
      const connection = raw.postgres as Record<string, unknown>;
      const hasConnectionString = checkConnectionString(connection.connectionString, errors);
      if (hasConnectionString && typeof connection.connectionString === "string") {
        postgres = { connectionString: connection.connectionString };
      }
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
  return {
    dialect: "postgres",
    postgres,
    migratorOutDir: raw.migratorOutDir as string,
    drizzleOutDir: raw.drizzleOutDir as string | undefined,
    lockName: (raw.lockName as string | undefined) ?? DEFAULT_LOCK_NAME,
    schema: raw.schema as string | undefined,
    tables: raw.tables as Partial<MigratorTablesConfig> | undefined,
    lock: raw.lock as Partial<MigratorLockConfig> | undefined,
    logger: (raw.logger as MigratorLogger | undefined) ?? console,
  };
}

/** Authoring-time sugar with full type checking; identical validation to the runner. */
export function defineConfig(input: MigratorCliConfigInput): MigratorCliConfig {
  return resolveCliConfig(input);
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
