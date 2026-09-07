import type { ResolvedConfig } from "./config.js";
import type { Migration } from "./migration.js";

export function sortMigrations(_migrations: readonly Migration[]): Migration[] {
  throw new Error("TODO: implement in Milestone 2 (registry sort + validate)");
}

export function validateRegistry(_migrations: readonly Migration[], _config: ResolvedConfig): void {
  throw new Error("TODO: implement in Milestone 2 (registry sort + validate)");
}
