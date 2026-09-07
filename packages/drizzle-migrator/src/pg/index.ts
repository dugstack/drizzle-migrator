import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createMigrationCli } from "../core/cli.js";
import type { CreateMigrationCliOptions } from "../core/cli.js";
import {
  adoptMigrations as adoptCore,
  runMigrations as runCore,
  getStatus as statusCore,
} from "../core/engine.js";
import type { GenerateMigrationEntryOptions, GenerateResult } from "../core/generate.js";
import type {
  AdoptResult,
  Migration,
  MigratorConfig,
  RunMigrationsResult,
  StatusReport,
} from "../core/index.js";
import { type PgDatabase, type PgTransaction, createPgAdapter } from "./adapter.js";

export * from "../core/index.js";
export { createMigrationCli };
export type { CreateMigrationCliOptions };
export type { GenerateMigrationEntryOptions, GenerateResult };
export type { PgDatabase, PgTransaction };

export type RunMigrationsOptions = {
  db: NodePgDatabase<Record<string, never>>;
  config: MigratorConfig;
  migrations: Migration[];
  dryRun?: boolean;
};

export type AdoptMigrationsOptions = {
  db: NodePgDatabase<Record<string, never>>;
  config: MigratorConfig;
  migrations: Migration[];
  from?: string;
  to?: string;
  force?: boolean;
  confirmDatabase: string;
};

export type GetStatusOptions = {
  db: NodePgDatabase<Record<string, never>>;
  config: MigratorConfig;
  migrations: Migration[];
};

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  return runCore({ ...options, adapter: createPgAdapter() });
}

export async function adoptMigrations(options: AdoptMigrationsOptions): Promise<AdoptResult> {
  return adoptCore({ ...options, adapter: createPgAdapter() });
}

export async function getStatus(options: GetStatusOptions): Promise<StatusReport> {
  return statusCore({ ...options, adapter: createPgAdapter() });
}

export async function generateMigrationEntry(
  _options: GenerateMigrationEntryOptions,
): Promise<GenerateResult> {
  throw new Error("TODO: implement in Milestone 5 (generate command)");
}
