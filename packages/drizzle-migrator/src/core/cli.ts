import { randomUUID } from "node:crypto";
import type { DialectAdapter } from "./adapter.js";
import type { MigratorConfig } from "./config.js";
import { adoptMigrations, errorDetail, getStatus, runMigrations } from "./engine.js";
import { generateMigrationEntry } from "./generate.js";
import type { Migration } from "./migration.js";
import { validateRegistry } from "./registry.js";

export type CliFlagType = "boolean" | "value";

export type CliFlagSpec = {
  name: string;
  type: CliFlagType;
  description: string;
};

export type CliCommandSpec = {
  name: string;
  description: string;
  flags: readonly CliFlagSpec[];
};

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    name: "migrate",
    description: "apply pending migrations; the only command a deploy pipeline runs",
    flags: [
      {
        name: "dry-run",
        type: "boolean",
        description: "print the statements that would run without executing anything",
      },
    ],
  },
  {
    name: "adopt",
    description: "record an existing database as already-migrated without executing SQL",
    flags: [
      {
        name: "from",
        type: "value",
        description: "first version to adopt (default: registry first)",
      },
      { name: "to", type: "value", description: "last version to adopt (default: registry last)" },
      {
        name: "force",
        type: "boolean",
        description: "continue adopting above the highest recorded version",
      },
      {
        name: "confirm-database",
        type: "value",
        description: "must match the connected database name (safety guard)",
      },
    ],
  },
  {
    name: "status",
    description: "show the current version, applied and pending migrations, recent audit logs",
    flags: [{ name: "json", type: "boolean", description: "print the status report as JSON" }],
  },
  {
    name: "generate",
    description: "scaffold a new migration entry from unapplied SQL files in sqlDir",
    flags: [
      { name: "version", type: "value", description: "skip the version prompt" },
      { name: "name", type: "value", description: "skip the name prompt" },
      { name: "yes", type: "boolean", description: "skip all prompts and use every default" },
      {
        name: "register",
        type: "boolean",
        description: "append the import + entry to the versions registry",
      },
    ],
  },
  {
    name: "validate",
    description: "lint the migration registry: versions, duplicates, sqlFiles, file existence",
    flags: [],
  },
];

export type ParsedArgv = {
  command: string;
  flags: Record<string, string | boolean>;
};

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (const arg of rest) {
    if (arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument "${arg}" — only --flags are accepted`);
    }
    const body = arg.slice(2);
    if (body.length === 0) {
      throw new Error(`empty flag "${arg}"`);
    }
    const equals = body.indexOf("=");
    if (equals === -1) {
      flags[body] = true;
      continue;
    }
    const key = body.slice(0, equals);
    const value = body.slice(equals + 1);
    if (key.length === 0) {
      throw new Error(`empty flag key in "${arg}"`);
    }
    if (value.length === 0) {
      throw new Error(`flag "--${key}=" has an empty value`);
    }
    flags[key] = value;
  }

  return { command, flags };
}

export function redactFlags(
  flags: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const redacted: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(flags)) {
    redacted[key] =
      typeof value === "string" && /password|secret|token|api[-_]?key/i.test(key)
        ? "[redacted]"
        : value;
  }
  return redacted;
}

export type CreateMigrationCliOptions<TDb = unknown, TTx = unknown> = {
  adapter: DialectAdapter<TDb, TTx>;
  config: MigratorConfig;
  migrations: readonly Migration[];
  connect: () => Promise<{ db: TDb; close: () => Promise<void> }>;
  argv?: readonly string[];
};

function printUsage(logger: MigratorConfig["logger"]): void {
  logger.info("Usage: migrator <command> [flags]");
  for (const spec of CLI_COMMANDS) {
    const flagList = spec.flags
      .map((flag) => (flag.type === "boolean" ? `--${flag.name}` : `--${flag.name}=`))
      .join(" ");
    logger.info(`  ${spec.name}${flagList.length > 0 ? ` ${flagList}` : ""}`);
    logger.info(`      ${spec.description}`);
  }
}

function flagList(spec: CliCommandSpec): string {
  return spec.flags.map((flag) => `--${flag.name}`).join(", ");
}

function validateCommandFlags(spec: CliCommandSpec, flags: Record<string, string | boolean>): void {
  const allowed = new Set(spec.flags.map((flag) => flag.name));
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw new Error(
        `unknown flag "--${key}" for command "${spec.name}" (supported: ${flagList(spec) || "none"})`,
      );
    }
  }
  for (const flag of spec.flags) {
    const value = flags[flag.name];
    if (value === undefined) {
      continue;
    }
    if (flag.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`flag "--${flag.name}" takes no value`);
    }
    if (flag.type === "value" && typeof value !== "string") {
      throw new Error(`flag "--${flag.name}" requires a value (--${flag.name}=<value>)`);
    }
  }
}

async function emitCliCommandAudit<TDb, TTx>(
  adapter: DialectAdapter<TDb, TTx>,
  db: TDb,
  config: MigratorConfig,
  command: string,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (command === "migrate" && flags["dry-run"] === true) {
    return;
  }
  try {
    await adapter.appendLog(db, config, {
      id: randomUUID(),
      kind: "cli.command",
      payload: { command, flags: redactFlags(flags) },
    });
  } catch (error) {
    config.logger.error(`[drizzle-migrator] failed to write audit event "cli.command":`, error);
  }
}

export async function createMigrationCli<TDb, TTx>(
  options: CreateMigrationCliOptions<TDb, TTx>,
): Promise<void> {
  const { adapter, config, migrations, connect } = options;
  const logger = config.logger;
  const argv = options.argv ?? process.argv.slice(2);

  let command: string;
  let flags: Record<string, string | boolean>;
  try {
    ({ command, flags } = parseArgv(argv));
  } catch (error) {
    logger.error(errorDetail(error));
    printUsage(logger);
    process.exitCode = 1;
    return;
  }

  const spec = CLI_COMMANDS.find((candidate) => candidate.name === command);
  if (!spec) {
    if (command.length > 0) {
      logger.error(`unknown command "${command}"`);
      printUsage(logger);
      process.exitCode = 1;
      return;
    }
    printUsage(logger);
    process.exitCode = 0;
    return;
  }

  try {
    validateCommandFlags(spec, flags);
  } catch (error) {
    logger.error(errorDetail(error));
    printUsage(logger);
    process.exitCode = 1;
    return;
  }

  if (spec.name === "validate") {
    try {
      await validateRegistry(migrations, config);
      logger.info(`registry ok: ${migrations.length} migration(s)`);
      process.exitCode = 0;
    } catch (error) {
      logger.error(errorDetail(error));
      process.exitCode = 1;
    }
    return;
  }

  let connection: { db: TDb; close: () => Promise<void> };
  try {
    connection = await connect();
  } catch (error) {
    logger.error(errorDetail(error));
    process.exitCode = 1;
    return;
  }

  try {
    await emitCliCommandAudit(adapter, connection.db, config, spec.name, flags);

    switch (spec.name) {
      case "migrate": {
        const result = await runMigrations({
          db: connection.db,
          adapter,
          config,
          migrations,
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
        const result = await adoptMigrations({
          db: connection.db,
          adapter,
          config,
          migrations,
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
        const report = await getStatus({ db: connection.db, adapter, config, migrations });
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
      case "generate": {
        const result = await generateMigrationEntry({
          config,
          migrations,
          version: typeof flags.version === "string" ? flags.version : undefined,
          name: typeof flags.name === "string" ? flags.name : undefined,
          yes: flags.yes === true,
          register: flags.register === true,
        });
        logger.info(
          `created ${result.entryPath} (version ${result.version}, name "${result.name}")`,
        );
        process.exitCode = 0;
        break;
      }
    }
  } catch (error) {
    logger.error(errorDetail(error));
    process.exitCode = 1;
  } finally {
    await connection.close().catch((error) => {
      logger.error("[drizzle-migrator] failed to close the connection:", error);
    });
  }
}
