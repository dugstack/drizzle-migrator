export {
  DEFAULT_LOCK_NAME,
  defineConfig,
  resolveCliConfig,
  toCoreConfig,
} from "./config.js";
export type {
  CliDialect,
  MigratorCliConfig,
  MigratorCliConfigInput,
  MysqlCliConfigInput,
  MysqlCliConnection,
  PostgresCliConfigInput,
  PostgresCliConnection,
  SqliteCliConfigInput,
  SqliteCliConnection,
} from "./config.js";
export { connectMysql, connectPostgres, connectSqlite } from "./connect.js";
export type { MysqlConnection, PgConnection, SqliteConnection } from "./connect.js";
export { connectDatabase, connectionKey, connectionSettingHint } from "./connection.js";
export type { CliConnection } from "./connection.js";
export {
  CLI_COMMANDS,
  flagList,
  parseCommandArgv,
  redactFlags,
  validateCommandFlags,
} from "./commands.js";
export type {
  CliCommandSpec,
  CliFlagSpec,
  CliFlagType,
  ParsedCommandArgv,
} from "./commands.js";
export { compareVersions, discoverMigrations, findMigratorConfigPath } from "./discovery.js";
export { findDrizzleConfigPath, resolveSqlDir } from "./drizzle-out.js";
export { createModuleLoader, unwrapDefaultExport } from "./loader.js";
export type { ModuleLoader } from "./loader.js";
export { askWithDefault } from "./prompts.js";
export { parseGlobalArgv, runCli } from "./run.js";
export type { GlobalFlags } from "./run.js";
export { printUsage } from "./usage.js";
