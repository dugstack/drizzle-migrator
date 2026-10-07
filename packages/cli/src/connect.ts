import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Connection as Mysql2Connection } from "mysql2/promise";
import { Client } from "pg";

export type PgConnection = {
  db: NodePgDatabase<Record<string, never>>;
  close: () => Promise<void>;
};

export type MysqlConnection = {
  db: MySql2Database<Record<string, never>>;
  close: () => Promise<void>;
};

export type SqliteConnection = {
  db: BetterSQLite3Database<Record<string, never>>;
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

/**
 * Loads an optional driver dependency with a clear message when it was
 * omitted. The mysql and sqlite drivers (and their drizzle wrappers, which
 * runtime-import the drivers) are loaded lazily so a postgres-only install
 * never touches them.
 */
async function loadOptionalModule<T>(
  loader: () => Promise<T>,
  dialect: string,
  installPackage: string,
): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    throw new Error(
      `the "${dialect}" dialect needs the "${installPackage}" package, which the CLI lists as an optional dependency — install it with "npm install ${installPackage}" (or drop --omit=optional)`,
      { cause: error },
    );
  }
}

/**
 * One dedicated session-scoped mysql2 Connection per command: the named
 * advisory lock (GET_LOCK/RELEASE_LOCK) is session-scoped, so acquire, run,
 * and release must share one connection — never a Pool.
 */
export async function connectMysql(connectionString: string): Promise<MysqlConnection> {
  const { drizzle: drizzleMysql } = await loadOptionalModule(
    () => import("drizzle-orm/mysql2"),
    "mysql",
    "mysql2",
  );
  const mysql = await loadOptionalModule(() => import("mysql2/promise"), "mysql", "mysql2");
  const createConnection = mysql.createConnection as (uri: string) => Promise<Mysql2Connection>;
  const connection = await createConnection(connectionString);
  return {
    db: drizzleMysql(connection),
    close: () => connection.end(),
  };
}

/** better-sqlite3 is synchronous; the close is wrapped to match the contract. */
export async function connectSqlite(path: string): Promise<SqliteConnection> {
  const { drizzle: drizzleSqlite } = await loadOptionalModule(
    () => import("drizzle-orm/better-sqlite3"),
    "sqlite",
    "better-sqlite3",
  );
  const betterSqlite3 = await loadOptionalModule(
    () => import("better-sqlite3"),
    "sqlite",
    "better-sqlite3",
  );
  const Database = betterSqlite3.default as new (path: string) => import("better-sqlite3").Database;
  const client = new Database(path);
  return {
    db: drizzleSqlite(client),
    close: async () => {
      client.close();
    },
  };
}
