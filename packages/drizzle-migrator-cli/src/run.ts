import { createMigrator } from "@dugstack/drizzle-migrator";
import { pgDialect } from "@dugstack/drizzle-migrator/pg";
import { resolveCliConfig, toCoreConfig } from "./config.js";
import { connectPostgres } from "./connect.js";
import { discoverMigrations, findMigratorConfigPath } from "./discovery.js";
import { resolveSqlDir } from "./drizzle-out.js";
import { createModuleLoader, unwrapDefaultExport } from "./loader.js";
import { printUsage } from "./usage.js";

export type GlobalFlags = {
  config: string | undefined;
  help: boolean;
  /** The command + its flags, forwarded verbatim to the core CLI dispatcher. */
  commandArgv: string[];
};

/**
 * Splits global flags (--config, --help) from the forwarded command. Global
 * flags are only recognized before the command starts; everything after the
 * first positional token is forwarded untouched so the core dispatcher owns
 * command-flag validation.
 */
export function parseGlobalArgv(argv: readonly string[]): GlobalFlags {
  const commandArgv: string[] = [];
  let config: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (commandArgv.length > 0) {
      commandArgv.push(arg);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--config requires a file path (--config=<path>)");
      }
      config = value;
      index++;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value.length === 0) {
        throw new Error("--config requires a file path (--config=<path>)");
      }
      config = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(
        `unknown global flag "${arg}" — only --config and --help may appear before the command`,
      );
    }
    commandArgv.push(arg);
  }

  return { config, help, commandArgv };
}

/**
 * Runs the `migrator` executable: resolves the config file, auto-discovers
 * migrations, wires the pg connection, and forwards the command to the core
 * CLI dispatcher (which owns exit codes, output, and the audit trail).
 */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let globals: GlobalFlags;
  try {
    globals = parseGlobalArgv(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage(console);
    process.exitCode = 1;
    return;
  }

  if (globals.help || globals.commandArgv.length === 0) {
    printUsage(console);
    process.exitCode = 0;
    return;
  }

  const cwd = process.cwd();
  try {
    const configPath = await findMigratorConfigPath(cwd, globals.config);
    const loader = createModuleLoader(configPath);
    const cliConfig = resolveCliConfig(unwrapDefaultExport(await loader(configPath)));
    const logger = cliConfig.logger;

    const sqlDir = await resolveSqlDir({ cli: cliConfig, cwd, loader, logger });
    const config = toCoreConfig(cliConfig, sqlDir);
    const migrations = await discoverMigrations({
      migrationsDir: cliConfig.migratorOutDir,
      loader,
      logger,
    });

    const migrator = createMigrator({ dialect: pgDialect, config, migrations });
    await migrator.createCli({
      connect: () => connectPostgres(cliConfig.postgres.connectionString),
      argv: globals.commandArgv,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
