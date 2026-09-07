import type { MigratorConfig } from "./config.js";
import type { Migration } from "./migration.js";

export type GenerateResult = {
  version: string;
  name: string;
  entryPath: string;
  sqlFiles: string[];
  registered: boolean;
};

export type GenerateMigrationEntryOptions = {
  config: MigratorConfig;
  migrations: readonly Migration[];
  version?: string;
  name?: string;
  yes?: boolean;
  register?: boolean;
};

export async function generateMigrationEntry(
  _options: GenerateMigrationEntryOptions,
): Promise<GenerateResult> {
  throw new Error("TODO: implement in Milestone 5 (generate command)");
}
