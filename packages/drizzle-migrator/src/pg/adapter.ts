import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { DialectAdapter } from "../core/adapter.js";

export function createPgAdapter(): DialectAdapter<NodePgDatabase<Record<string, never>>, unknown> {
  throw new Error("TODO: implement in Milestone 3 (pg adapter)");
}
