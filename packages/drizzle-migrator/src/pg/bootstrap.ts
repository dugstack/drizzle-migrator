import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ResolvedConfig } from "../core/config.js";

export async function bootstrapTrackingTables(
  _db: NodePgDatabase<Record<string, never>>,
  _config: ResolvedConfig,
): Promise<void> {
  throw new Error("TODO: implement in Milestone 3 (tracking DDL + drift assertion)");
}
