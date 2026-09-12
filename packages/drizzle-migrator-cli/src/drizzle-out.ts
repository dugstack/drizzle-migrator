import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { MigratorLogger } from "@dugstack/drizzle-migrator";
import type { MigratorCliConfig } from "./config.js";
import type { ModuleLoader } from "./loader.js";
import { unwrapDefaultExport } from "./loader.js";

export const DRIZZLE_CONFIG_BASENAME = "drizzle.config";
export const DEFAULT_SQL_DIR = "./drizzle";

const DRIZZLE_CONFIG_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Finds a drizzle-kit config in cwd; returns null when none exists. */
export async function findDrizzleConfigPath(cwd: string): Promise<string | null> {
  for (const extension of DRIZZLE_CONFIG_EXTENSIONS) {
    const candidate = resolve(cwd, DRIZZLE_CONFIG_BASENAME + extension);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves the drizzle-kit SQL directory: `drizzleOutDir` wins; otherwise the
 * `out` field of the drizzle config; otherwise "./drizzle".
 */
export async function resolveSqlDir(options: {
  cli: MigratorCliConfig;
  cwd: string;
  loader: ModuleLoader;
  logger: MigratorLogger;
}): Promise<string> {
  const { cli, cwd, loader, logger } = options;

  if (cli.drizzleOutDir !== undefined) {
    return cli.drizzleOutDir;
  }

  const configPath = await findDrizzleConfigPath(cwd);
  if (configPath === null) {
    logger.info(
      `no drizzleOutDir configured and no ${DRIZZLE_CONFIG_BASENAME}.* found in ${cwd} — using "${DEFAULT_SQL_DIR}"`,
    );
    return DEFAULT_SQL_DIR;
  }

  const loaded = unwrapDefaultExport(await loader(configPath));
  const out =
    typeof loaded === "object" && loaded !== null ? (loaded as { out?: unknown }).out : undefined;
  if (typeof out !== "string" || out.length === 0) {
    logger.info(
      `drizzle config ${configPath} has no usable "out" field — using "${DEFAULT_SQL_DIR}"`,
    );
    return DEFAULT_SQL_DIR;
  }
  return out;
}
