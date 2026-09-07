import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createMigrationCli } from "../core/cli.js";
import type { CreateMigrationCliOptions } from "../core/cli.js";
import { generateMigrationEntry } from "../core/generate.js";
import type { GenerateMigrationEntryOptions } from "../core/generate.js";
import type {
  AdoptResult,
  Migration,
  MigratorConfig,
  RunMigrationsResult,
  StatusReport,
} from "../core/index.js";

export * from "../core/index.js";
export { createMigrationCli };
export type { CreateMigrationCliOptions };
export { generateMigrationEntry };
export type { GenerateMigrationEntryOptions };

export type RunMigrationsOptions = {
  db: NodePgDatabase<Record<string, never>>;
  config: MigratorConfig;
  migrations: Migration[];
  dryRun?: boolean;
};

export async function runMigrations(_options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  throw new Error("TODO: implement in Milestone 3 (bind core engine to the pg adapter)");
}

export type AdoptMigrationsOptions = {
  db: NodePgDatabase<Record<string, never>>;
  config: MigratorConfig;
  migrations: Migration[];
  from?: string;
  to?: string;
  force?: boolean;
  confirmDatabase: string;
};

export async function adoptMigrations(_options: AdoptMigrationsOptions): Promise<AdoptResult> {
  throw new Error("TODO: implement in Milestone 5 (adopt command, pg binding)");
}

export type GetStatusOptions = {
  db: NodePgDatabase<Record<string, never>>;
  config: MigratorConfig;
  migrations: Migration[];
};

export async function getStatus(_options: GetStatusOptions): Promise<StatusReport> {
  throw new Error("TODO: implement in Milestone 3 (pg binding)");
}
