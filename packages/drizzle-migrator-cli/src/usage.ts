import type { MigratorLogger } from "@dugstack/drizzle-migrator";
import { CLI_COMMANDS } from "./commands.js";

/**
 * Usage rendering reads the single command table (src/commands.ts) — there is
 * no mirrored copy to keep in sync anymore.
 */
export function printUsage(logger: MigratorLogger): void {
  logger.info("Usage: migrator [--config=<path>] <command> [flags]");
  logger.info("Global flags:");
  logger.info("  --config=<path>");
  logger.info("      path to the migrator config (default: ./drizzle-migrator.config.ts)");
  logger.info("  --help, -h");
  logger.info("      print this usage");
  logger.info("Commands:");
  for (const spec of CLI_COMMANDS) {
    const flagList = spec.flags
      .map((flag) => (flag.type === "boolean" ? `--${flag.name}` : `--${flag.name}=`))
      .join(" ");
    logger.info(`  ${spec.name}${flagList.length > 0 ? ` ${flagList}` : ""}`);
    logger.info(`      ${spec.description}`);
  }
}
