import type { CliDialect, MigratorCliConfig } from "./config.js";
import { connectMysql, connectPostgres, connectSqlite } from "./connect.js";

/**
 * The dialect-erased handle the command executor works with: the CLI builds
 * the concrete drizzle database per dialect (connection.ts owns the wiring)
 * and the core adapters receive their own concrete handle at runtime.
 */
export type CliConnection = {
  db: unknown;
  close: () => Promise<void>;
};

/** The configured connection key per dialect; undefined means "no connection block". */
export function connectionKey(cliConfig: MigratorCliConfig): string | undefined {
  switch (cliConfig.dialect) {
    case "mysql":
      return cliConfig.mysql?.connectionString;
    case "sqlite":
      return cliConfig.sqlite?.path;
    case "postgres":
      return cliConfig.postgres?.connectionString;
  }
}

export function connectionSettingHint(dialect: CliDialect): string {
  return dialect === "sqlite" ? '"sqlite.path"' : `"${dialect}.connectionString"`;
}

/** Opens the one dedicated connection a database command runs on. */
export async function connectDatabase(cliConfig: MigratorCliConfig): Promise<CliConnection> {
  switch (cliConfig.dialect) {
    case "mysql": {
      const connectionString = cliConfig.mysql?.connectionString;
      if (connectionString === undefined) {
        throw new Error(
          `the "mysql" connection block has no usable "connectionString" — set "mysql.connectionString" (a mysql:// URL) in the migrator config`,
        );
      }
      return connectMysql(connectionString);
    }
    case "sqlite": {
      const path = cliConfig.sqlite?.path;
      if (path === undefined) {
        throw new Error(
          `the "sqlite" connection block has no usable "path" — set "sqlite.path" (a database file path) in the migrator config`,
        );
      }
      return connectSqlite(path);
    }
    case "postgres": {
      const connectionString = cliConfig.postgres?.connectionString;
      if (connectionString === undefined) {
        throw new Error(
          `the "postgres" connection block has no usable "connectionString" — set "postgres.connectionString" in the migrator config`,
        );
      }
      return connectPostgres(connectionString);
    }
  }
}
