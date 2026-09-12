import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";

export type PgConnection = {
  db: NodePgDatabase<Record<string, never>>;
  close: () => Promise<void>;
};

/**
 * The CLI owns the pg wiring: one dedicated session-scoped client per command
 * (the advisory lock must be acquired, held, and released on a single
 * connection), wrapped in drizzle for the core engine.
 */
export async function connectPostgres(connectionString: string): Promise<PgConnection> {
  const client = new Client({ connectionString });
  await client.connect();
  return {
    db: drizzle(client),
    close: () => client.end(),
  };
}
