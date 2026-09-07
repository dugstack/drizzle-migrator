import type { MigratorConfig } from "./config.js";
import type { Migration } from "./migration.js";

export type CreateMigrationCliOptions<TDb = unknown> = {
  config: MigratorConfig;
  migrations: readonly Migration[];
  connect: () => Promise<{ db: TDb; close: () => Promise<void> }>;
};

export async function createMigrationCli<TDb = unknown>(
  _options: CreateMigrationCliOptions<TDb>,
): Promise<void> {
  throw new Error("TODO: implement in Milestone 4 (CLI + config)");
}
