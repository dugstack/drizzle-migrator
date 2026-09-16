import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.js";
import type { Migration } from "./migration.js";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const FLAT_VERSION_FILE_PATTERN = /^\d+\.\d+\.\d+\.ts$/;

export function compareVersions(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10));
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10));

  for (let i = 0; i < 3; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) {
      return av - bv;
    }
  }
  return 0;
}

export function sortMigrations(migrations: readonly Migration[]): Migration[] {
  return [...migrations].sort((a, b) => compareVersions(a.version, b.version));
}

export function sqlFilesOf(migration: Migration): readonly string[] {
  return migration.sqlFiles ?? [];
}

export async function validateRegistry(
  migrations: readonly Migration[],
  config: ResolvedConfig,
): Promise<Migration[]> {
  const errors: string[] = [];
  const seenVersions = new Map<string, Migration>();
  const fileOwners = new Map<string, string[]>();

  for (const migration of migrations) {
    if (typeof migration.version !== "string" || !VERSION_PATTERN.test(migration.version)) {
      errors.push(
        `migration "${migration.name}": version "${String(migration.version)}" must match \\d+\\.\\d+\\.\\d+`,
      );
      continue;
    }
    const existing = seenVersions.get(migration.version);
    if (existing) {
      errors.push(
        `duplicate version ${migration.version}: declared by both "${existing.name}" and "${migration.name}"`,
      );
    } else {
      seenVersions.set(migration.version, migration);
    }
    for (const file of sqlFilesOf(migration)) {
      const owners = fileOwners.get(file) ?? [];
      owners.push(migration.name);
      fileOwners.set(file, owners);
    }
  }

  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) {
      errors.push(
        `SQL file "${file}" is declared by multiple migrations (${owners.join(", ")}) — a file is applied exactly once`,
      );
    }
    try {
      await stat(join(config.sqlDir, file));
    } catch {
      errors.push(
        `SQL file "${file}" (declared by ${owners.join(", ")}) not found under ${config.sqlDir}`,
      );
    }
  }

  try {
    const dirents = await readdir(config.migrationsDir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isFile() && FLAT_VERSION_FILE_PATTERN.test(dirent.name)) {
        errors.push(
          `flat file "${dirent.name}" in ${config.migrationsDir} — the layout is uniformly folder-per-version (v<semver>/index.ts)`,
        );
      }
    }
  } catch {
    errors.push(`migrationsDir ${config.migrationsDir} not found`);
  }

  for (const migration of seenVersions.values()) {
    const folder = join(config.migrationsDir, `v${migration.version}`);
    try {
      const info = await stat(folder);
      if (!info.isDirectory()) {
        errors.push(
          `migration ${migration.version}: "v${migration.version}" exists in ${config.migrationsDir} but is not a folder`,
        );
      }
    } catch {
      errors.push(
        `migration ${migration.version}: no folder "v${migration.version}" in ${config.migrationsDir} — the folder name must be exactly "v" + the version field`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `invalid migration registry:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  return sortMigrations(migrations);
}
