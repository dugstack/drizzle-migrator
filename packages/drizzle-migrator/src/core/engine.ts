import type { DialectAdapter } from "./adapter.js";
import type { MigratorConfig } from "./config.js";
import type { Migration } from "./migration.js";
import type { AdoptResult, RunMigrationsResult, StatusReport } from "./result.js";

export type EngineOptions = {
  db: unknown;
  adapter: DialectAdapter;
  config: MigratorConfig;
  migrations: readonly Migration[];
  dryRun?: boolean;
};

export async function runMigrations(_options: EngineOptions): Promise<RunMigrationsResult> {
  throw new Error("TODO: implement in Milestone 2 (core engine)");
}

export type AdoptOptions = {
  db: unknown;
  adapter: DialectAdapter;
  config: MigratorConfig;
  migrations: readonly Migration[];
  from?: string;
  to?: string;
  force?: boolean;
  confirmDatabase: string;
};

export async function adoptMigrations(_options: AdoptOptions): Promise<AdoptResult> {
  throw new Error("TODO: implement in Milestone 5 (adopt command)");
}

export type StatusOptions = {
  db: unknown;
  adapter: DialectAdapter;
  config: MigratorConfig;
  migrations: readonly Migration[];
};

export async function getStatus(_options: StatusOptions): Promise<StatusReport> {
  throw new Error("TODO: implement in Milestone 2 (core engine)");
}
