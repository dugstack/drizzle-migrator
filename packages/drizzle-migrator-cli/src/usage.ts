import type { MigratorLogger } from "@dugstack/drizzle-migrator";

export type UsageFlag = { name: string; type: "boolean" | "value"; description: string };

export type UsageCommand = {
  name: string;
  description: string;
  flags: readonly UsageFlag[];
};

/**
 * Mirrors the core package's internal CLI dispatch table (src/core/cli.ts) — the
 * executable forwards commands to it unchanged. test/usage-sync.test.ts fails if
 * this table drifts from the core one.
 */
export const USAGE_COMMANDS: readonly UsageCommand[] = [
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

export function printUsage(logger: MigratorLogger): void {
  logger.info("Usage: migrator [--config=<path>] <command> [flags]");
  logger.info("Global flags:");
  logger.info("  --config=<path>");
  logger.info("      path to the migrator config (default: ./drizzle-migrator.config.ts)");
  logger.info("  --help, -h");
  logger.info("      print this usage");
  logger.info("Commands:");
  for (const spec of USAGE_COMMANDS) {
    const flagList = spec.flags
      .map((flag) => (flag.type === "boolean" ? `--${flag.name}` : `--${flag.name}=`))
      .join(" ");
    logger.info(`  ${spec.name}${flagList.length > 0 ? ` ${flagList}` : ""}`);
    logger.info(`      ${spec.description}`);
  }
}
