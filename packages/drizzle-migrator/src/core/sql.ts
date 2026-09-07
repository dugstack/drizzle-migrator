import type { RunSqlFileRange } from "./migration.js";

export function splitStatements(_sql: string): string[] {
  throw new Error("TODO: implement in Milestone 2 (statement-breakpoint splitting)");
}

export function sliceStatements(
  _statements: readonly string[],
  _range?: RunSqlFileRange,
): string[] {
  throw new Error("TODO: implement in Milestone 2 (breakpoint range slicing)");
}
