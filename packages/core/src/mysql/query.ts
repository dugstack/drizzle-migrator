import type { SQL } from "drizzle-orm";
import type { MysqlDatabase, MysqlTransaction } from "./adapter.js";

/**
 * drizzle-orm/mysql2 types every raw `execute` result as
 * `[ResultSetHeader, FieldPacket[]]` — the row generic is not reflected in the
 * result type — while at runtime the first tuple element is the row array for
 * SELECTs. This keeps the one cast in one place.
 */
export async function queryRows<TRow>(
  db: MysqlDatabase | MysqlTransaction,
  query: SQL,
): Promise<TRow[]> {
  const [rows] = await db.execute(query);
  return rows as unknown as TRow[];
}
