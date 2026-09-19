import {
  type Migration,
  type MigrationEntriesValidationResult,
  type MigratorConfig,
  type MigratorLogger,
  createMigrator,
} from "@dugstack/drizzle-migrator";
import { pgDialect } from "@dugstack/drizzle-migrator/pg";
import {
  CLI_COMMANDS,
  type CliCommandSpec,
  parseCommandArgv,
  redactFlags,
  validateCommandFlags,
} from "./commands.js";
import { type MigratorCliConfig, resolveCliConfig, toCoreConfig } from "./config.js";
import { type PgConnection, connectPostgres } from "./connect.js";
import { discoverMigrations, findMigratorConfigPath } from "./discovery.js";
import { resolveSqlDir } from "./drizzle-out.js";
import { createModuleLoader, unwrapDefaultExport } from "./loader.js";
import { askWithDefault } from "./prompts.js";
import { printUsage } from "./usage.js";

/** The pg-bound migrator the executable builds per invocation. */
function createPgMigrator(options: { config: MigratorConfig; migrations: Migration[] }) {
  return createMigrator({
    dialect: pgDialect,
    config: options.config,
    migrations: options.migrations,
  });
}

type CliMigrator = ReturnType<typeof createPgMigrator>;

export type GlobalFlags = {
  config: string | undefined;
  help: boolean;
  /** The command + its flags, parsed against the CLI command table. */
  commandArgv: string[];
};

/**
 * Splits global flags (--config, --help) from the command. Global flags are
 * only recognized before the command starts; everything after the first
 * positional token is the command's own argv, which the CLI parses against the
 * single command table (src/commands.ts).
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Output rendering of a validation result; exit codes map from result.ok. */
function reportValidation(
  logger: MigratorLogger,
  migrationCount: number,
  result: MigrationEntriesValidationResult,
): void {
  if (result.ok) {
    logger.info(`registry ok: ${migrationCount} migration(s)`);
    process.exitCode = 0;
    return;
  }
  for (const message of result.errors) {
    logger.error(message);
  }
  process.exitCode = 1;
}

/**
 * Appends the redacted cli.command audit event through the migrator's public
 * service method. Audit failures are logged, never fatal — mirroring the
 * engine's own audit behavior. Dry runs record nothing.
 */
async function emitCliCommandAudit(
  migrator: CliMigrator,
  logger: MigratorLogger,
  db: Parameters<CliMigrator["appendAuditEvent"]>[0]["db"],
  command: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (command === "migrate" && flags["dry-run"] === true) {
    return;
  }
  try {
    await migrator.appendAuditEvent({
      db,
      entry: { kind: "cli.command", payload: { command, flags: redactFlags(flags) } },
    });
  } catch (error) {
    logger.error(`[drizzle-migrator] failed to write audit event "cli.command":`, error);
  }
}

async function closeConnection(logger: MigratorLogger, connection: PgConnection): Promise<void> {
  await connection.close().catch((error) => {
    logger.error("[drizzle-migrator] failed to close the connection:", error);
  });
}

type CommandContext = {
  spec: CliCommandSpec;
  flags: Record<string, string | boolean>;
  migrator: CliMigrator;
  cliConfig: MigratorCliConfig;
  migrationCount: number;
  logger: MigratorLogger;
};

/**
 * Connection-free commands (requiresDatabase: false in the command table).
 * generate: the core owns the defaults via its suggestion API, the CLI owns
 * prompting when --yes is absent; generation always receives explicit values.
 * validate: with a configured connection string one dedicated connection
 * carries the validation audit trail and is always closed — even when
 * validation or its audit writes fail.
 */
async function runConnectionFreeCommand(context: CommandContext): Promise<void> {
  const { spec, flags, migrator, cliConfig, migrationCount, logger } = context;
  const command = spec.name;

  if (command === "generate") {
    try {
      const suggestion = migrator.suggestMigrationEntry();
      let version = typeof flags.version === "string" ? flags.version : undefined;
      let name = typeof flags.name === "string" ? flags.name : undefined;
      if (flags.yes !== true) {
        if (version === undefined) {
          version = await askWithDefault(`Version [${suggestion.version}]: `, suggestion.version);
        }
        if (name === undefined) {
          name = await askWithDefault(`Name [${suggestion.name}]: `, suggestion.name);
        }
      }
      const result = await migrator.generateMigrationEntry({
        version: version ?? suggestion.version,
        name: name ?? suggestion.name,
        register: flags.register === true,
      });
      logger.info(`created ${result.entryPath} (version ${result.version}, name "${result.name}")`);
      process.exitCode = 0;
    } catch (error) {
      logger.error(errorMessage(error));
      process.exitCode = 1;
    }
    return;
  }

  // validate
  const connectionString = cliConfig.postgres?.connectionString;
  if (connectionString === undefined) {
    // No connection requested: validation stays completely connection-free and
    // audit failures are impossible.
    try {
      reportValidation(logger, migrationCount, await migrator.validateMigrationEntries());
    } catch (error) {
      logger.error(errorMessage(error));
      process.exitCode = 1;
    }
    return;
  }
  let connection: PgConnection;
  try {
    connection = await connectPostgres(connectionString);
  } catch (error) {
    // A requested connection that cannot be established is a CLI error.
    logger.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }
  try {
    reportValidation(
      logger,
      migrationCount,
      await migrator.validateMigrationEntries({ db: connection.db }),
    );
  } catch (error) {
    logger.error(errorMessage(error));
    process.exitCode = 1;
  } finally {
    await closeConnection(logger, connection);
  }
}

/**
 * Database commands (requiresDatabase: true in the command table): migrate,
 * adopt, status. One dedicated pg connection per command (the advisory lock is
 * session-scoped), the redacted cli.command audit event, all failure rendering,
 * and the guaranteed close in the finally block are CLI-owned.
 */
async function runDatabaseCommand(context: CommandContext): Promise<void> {
  const { spec, flags, migrator, cliConfig, logger } = context;
  const command = spec.name;

  const connectionString = cliConfig.postgres?.connectionString;
  if (connectionString === undefined) {
    // Fails before any connection attempt.
    logger.error(
      `command "${command}" requires a database connection — set "postgres.connectionString" in the migrator config`,
    );
    process.exitCode = 1;
    return;
  }

  let connection: PgConnection;
  try {
    connection = await connectPostgres(connectionString);
  } catch (error) {
    logger.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }

  try {
    await emitCliCommandAudit(migrator, logger, connection.db, command, flags);

    switch (command) {
      case "migrate": {
        const result = await migrator.runMigrations({
          db: connection.db,
          dryRun: flags["dry-run"] === true,
        });
        if (result.dryRun.length > 0) {
          logger.info(
            `dry run: ${result.dryRun.length} pending migration(s) would run: ${result.dryRun.join(", ")}`,
          );
        } else if (result.applied.length === 0) {
          logger.info(
            `no pending migrations${result.skipped.length > 0 ? ` (${result.skipped.length} already applied)` : ""}`,
          );
        } else {
          logger.info(`applied ${result.applied.length}: ${result.applied.join(", ")}`);
        }
        process.exitCode = 0;
        break;
      }
      case "adopt": {
        const confirmDatabase = flags["confirm-database"];
        if (typeof confirmDatabase !== "string") {
          throw new Error(
            "adopt requires --confirm-database=<name> matching the connected database — a stale DATABASE_URL must never adopt the wrong database",
          );
        }
        const result = await migrator.adoptMigrations({
          db: connection.db,
          from: typeof flags.from === "string" ? flags.from : undefined,
          to: typeof flags.to === "string" ? flags.to : undefined,
          force: flags.force === true,
          confirmDatabase,
        });
        if (result.adopted.length > 0) {
          logger.info(`adopted ${result.adopted.length}: ${result.adopted.join(", ")}`);
        } else {
          logger.info("nothing adopted");
        }
        if (result.notAdopted.length > 0) {
          logger.info(`not adopted (above --to): ${result.notAdopted.join(", ")}`);
        }
        process.exitCode = 0;
        break;
      }
      case "status": {
        const report = await migrator.getStatus({ db: connection.db });
        if (flags.json === true) {
          logger.info(JSON.stringify(report, null, 2));
        } else {
          logger.info(`current version: ${report.currentVersion ?? "none"}`);
          if (report.applied.length === 0) {
            logger.info("applied: none");
          } else {
            logger.info(`applied: ${report.applied.length}`);
            for (const row of report.applied) {
              logger.info(`  - ${row.version} "${row.name}" (${row.origin} at ${row.appliedAt})`);
            }
          }
          if (report.pending.length === 0) {
            logger.info("pending: none");
          } else {
            logger.info(`pending: ${report.pending.length}`);
            for (const row of report.pending) {
              logger.info(`  - ${row.version} "${row.name}"`);
            }
          }
          if (report.recentLogs.length === 0) {
            logger.info("recent logs: none");
          } else {
            logger.info("recent logs:");
            for (const row of report.recentLogs) {
              logger.info(
                `  ${row.at} ${row.kind}${row.version ? ` [${row.version}]` : ""}${row.detail ? ` ${row.detail}` : ""}`,
              );
            }
          }
        }
        process.exitCode = 0;
        break;
      }
    }
  } catch (error) {
    logger.error(errorMessage(error));
    process.exitCode = 1;
  } finally {
    await closeConnection(logger, connection);
  }
}

/** Dispatches on the command table entry: requiresDatabase picks the path. */
async function executeCommand(context: CommandContext): Promise<void> {
  if (context.spec.requiresDatabase) {
    await runDatabaseCommand(context);
    return;
  }
  await runConnectionFreeCommand(context);
}

/**
 * Runs the `drizzle-migrator` executable. The CLI owns everything argv-shaped (global
 * flags, command parsing, flag validation) plus output, exit codes, prompts,
 * and the Postgres connection lifecycle; the core package is a pure
 * programmatic service that receives only structured calls.
 */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let globals: GlobalFlags;
  try {
    globals = parseGlobalArgv(argv);
  } catch (error) {
    console.error(errorMessage(error));
    printUsage(console);
    process.exitCode = 1;
    return;
  }

  if (globals.help || globals.commandArgv.length === 0) {
    printUsage(console);
    process.exitCode = 0;
    return;
  }

  // Command parsing and flag validation run before any filesystem or config
  // work: the CLI owns dispatch, so a bad invocation fails fast.
  let command = "";
  let flags: Record<string, string | boolean> = {};
  try {
    ({ command, flags } = parseCommandArgv(globals.commandArgv));
  } catch (error) {
    console.error(errorMessage(error));
    printUsage(console);
    process.exitCode = 1;
    return;
  }

  const spec = CLI_COMMANDS.find((candidate) => candidate.name === command);
  if (!spec) {
    if (command.length > 0) {
      console.error(`unknown command "${command}"`);
      printUsage(console);
      process.exitCode = 1;
      return;
    }
    printUsage(console);
    process.exitCode = 0;
    return;
  }

  try {
    validateCommandFlags(spec, flags);
  } catch (error) {
    console.error(errorMessage(error));
    printUsage(console);
    process.exitCode = 1;
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

    const migrator = createPgMigrator({ config, migrations });
    await executeCommand({
      spec,
      flags,
      migrator,
      cliConfig,
      migrationCount: migrations.length,
      logger,
    });
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
