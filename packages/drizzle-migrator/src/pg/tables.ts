import type { PgTable } from "drizzle-orm/pg-core";
import type { ResolvedConfig } from "../core/config.js";

export type TrackingTables = {
  versions: PgTable;
  logs: PgTable;
};

export function createTrackingTables(_config: ResolvedConfig): TrackingTables {
  throw new Error("TODO: implement in Milestone 3 (tracking table definitions)");
}
