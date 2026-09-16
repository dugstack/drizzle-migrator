import type { RunSqlFileRange } from "./migration.js";

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export function splitStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function sliceStatements(statements: readonly string[], range?: RunSqlFileRange): string[] {
  const from = range?.from ?? 0;
  const to = range?.to ?? statements.length;

  if (!Number.isInteger(from) || from < 0) {
    throw new Error(`Invalid sqlFile range: "from" must be a non-negative integer, got ${from}`);
  }
  if (!Number.isInteger(to)) {
    throw new Error(`Invalid sqlFile range: "to" must be an integer, got ${to}`);
  }
  if (to < from) {
    throw new Error(`Invalid sqlFile range: "to" (${to}) must not be less than "from" (${from})`);
  }
  if (to > statements.length) {
    throw new Error(
      `Invalid sqlFile range: "to" (${to}) exceeds statement count (${statements.length})`,
    );
  }

  return statements.slice(from, to);
}
