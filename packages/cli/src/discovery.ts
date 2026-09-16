import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Migration, MigratorLogger } from "@dugstack/drizzle-migrator";
import type { ModuleLoader } from "./loader.js";

export const MIGRATOR_CONFIG_BASENAME = "drizzle-migrator.config";
export const MIGRATION_FOLDER_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const FLAT_VERSION_FILE_PATTERN = /^\d+\.\d+\.\d+\.ts$/;
const CONFIG_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const;

/** Numeric semver comparison (0.10.0 > 0.9.0); duplicated from core, which keeps it internal. */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10));
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index++) {
    const av = aParts[index] ?? 0;
    const bv = bParts[index] ?? 0;
    if (av !== bv) {
      return av - bv;
    }
  }
  return 0;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves the migrator CLI config file. An explicit path wins (with the
 * standard extensions attempted when the path has none); otherwise the cwd is
 * scanned for drizzle-migrator.config.<ext>.
 */
export async function findMigratorConfigPath(cwd: string, explicit?: string): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) {
    const direct = resolve(cwd, explicit);
    if (await fileExists(direct)) {
      return direct;
    }
    for (const extension of CONFIG_EXTENSIONS) {
      const withExtension = direct + extension;
      if (await fileExists(withExtension)) {
        return withExtension;
      }
    }
    throw new Error(`migrator config not found: ${explicit} (resolved ${direct})`);
  }
  for (const extension of CONFIG_EXTENSIONS) {
    const candidate = resolve(cwd, MIGRATOR_CONFIG_BASENAME + extension);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no migrator config found in ${cwd} — create drizzle-migrator.config.ts or pass --config <path>`,
  );
}

type MigrationFolder = { folder: string; version: string };

function isMigrationShape(value: unknown): value is Migration {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Migration).version === "string" &&
    typeof (value as Migration).up === "function"
  );
}

/**
 * Auto-discovers migrations as `<migratorOutDir>/v<semver>/index.ts` — no manual
 * registry file. Validates version-folder naming (folder === "v" + the entry's
 * version field, one migration export per folder) before anything touches the
 * database, and returns the migrations sorted numerically by semver.
 */
export async function discoverMigrations(options: {
  migrationsDir: string;
  loader: ModuleLoader;
  logger: MigratorLogger;
}): Promise<Migration[]> {
  const { migrationsDir, loader, logger } = options;

  let dirents: Dirent[];
  try {
    dirents = await readdir(migrationsDir, { withFileTypes: true });
  } catch {
    logger.info(`migratorOutDir ${migrationsDir} does not exist yet — no migrations discovered`);
    return [];
  }

  const folders: MigrationFolder[] = [];
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      const match = MIGRATION_FOLDER_PATTERN.exec(dirent.name);
      if (!match) {
        throw new Error(
          `invalid migration folder ${JSON.stringify(dirent.name)} in ${migrationsDir} — folders must be named "v<semver>" (e.g. v0.0.1)`,
        );
      }
      folders.push({ folder: dirent.name, version: dirent.name.slice(1) });
      continue;
    }
    if (dirent.isFile()) {
      if (FLAT_VERSION_FILE_PATTERN.test(dirent.name)) {
        throw new Error(
          `flat file ${JSON.stringify(dirent.name)} in ${migrationsDir} — the layout is uniformly folder-per-version (v<semver>/index.ts)`,
        );
      }
      if (dirent.name === "index.ts") {
        logger.info(
          `ignoring ${resolve(migrationsDir, "index.ts")} — the CLI auto-discovers v*/ folders; no registry file is needed`,
        );
      }
    }
  }

  folders.sort((a, b) => compareVersions(a.version, b.version));

  const migrations: Migration[] = [];
  for (const { folder, version } of folders) {
    const entryPath = resolve(migrationsDir, folder, "index.ts");
    if (!(await fileExists(entryPath))) {
      throw new Error(
        `migration folder ${JSON.stringify(folder)} has no index.ts (expected ${entryPath})`,
      );
    }
    const loaded = await loader(entryPath);
    const exports = Object.entries(loaded as Record<string, unknown>).filter(
      ([key, value]) => key !== "__esModule" && isMigrationShape(value),
    );
    if (exports.length === 0) {
      throw new Error(
        `no migration export found in ${entryPath} — each v<semver>/index.ts must export a defineMigration({...})`,
      );
    }
    if (exports.length > 1) {
      throw new Error(
        `${entryPath} exports ${exports.length} migrations (${exports.map(([key]) => key).join(", ")}) — one migration per version folder`,
      );
    }
    const migration = exports[0]?.[1] as Migration;
    if (migration.version !== version) {
      throw new Error(
        `migration ${JSON.stringify(folder)} declares version ${JSON.stringify(migration.version)} — the folder name must be exactly "v" + the version field`,
      );
    }
    migrations.push(migration);
  }
  return migrations;
}
