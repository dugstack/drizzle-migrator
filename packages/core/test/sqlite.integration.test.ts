import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptMigrations, getStatus, runMigrations } from "../src/core/engine.js";
import { type Migration, defineConfig, defineMigration } from "../src/core/index.js";
import { type SqliteDatabase, createSqliteAdapter } from "../src/sqlite/adapter.js";
import { sqliteDialect } from "../src/sqlite/index.js";
import { createTrackingTables } from "../src/sqlite/tables.js";
import { createFakeLogger } from "./fake-adapter.js";

const TIMEOUT = 30_000;

describe("sqlite integration (better-sqlite3)", () => {
  let tmpBase: string;

  beforeAll(async () => {
    tmpBase = await mkdtemp(join(tmpdir(), "drizzle-migrator-sqlite-"));
  }, TIMEOUT);

  beforeEach(() => {
    Reflect.deleteProperty(process.env, "CI");
  });

  type Fixture = {
    db: SqliteDatabase;
    client: Database.Database;
    dbPath: string;
    config: ReturnType<typeof defineConfig>;
  };

  async function freshDb(
    name: string,
    sqlFiles: Record<string, string> = {},
    versions: string[] = [],
  ): Promise<Fixture> {
    const dir = join(tmpBase, name);
    const sqlDir = join(dir, "sql");
    const migrationsDir = join(dir, "versions");
    await mkdir(sqlDir, { recursive: true });
    await mkdir(migrationsDir, { recursive: true });
    for (const [file, content] of Object.entries(sqlFiles)) {
      await writeFile(join(sqlDir, file), content, "utf8");
    }
    for (const version of versions) {
      const folder = join(migrationsDir, `v${version}`);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "index.ts"), "export const placeholder = true;\n", "utf8");
    }

    const logger = createFakeLogger();
    const config = defineConfig({
      sqlDir,
      migrationsDir,
      lockName: `test:${name}:migrations`,
      logger,
    });
    const dbPath = join(dir, `${name}.db`);
    const client = new Database(dbPath);
    const db: SqliteDatabase = drizzle(client);
    return { db, client, dbPath, config };
  }

  it("validates identifiers and exposes the sqlite dialect token", () => {
    expect(sqliteDialect.id).toBe("sqlite");
    expect(sqliteDialect.quoteIdentifier("ok_name1")).toBe('"ok_name1"');
    expect(() => sqliteDialect.quoteIdentifier('bad"name')).toThrow(/invalid identifier/);
    expect(() => sqliteDialect.quoteIdentifier("UPPER")).toThrow(/invalid identifier/);
    expect(() => sqliteDialect.quoteIdentifier("1leading")).toThrow(/invalid identifier/);
    expect(() => sqliteDialect.quoteIdentifier("semi;colon")).toThrow(/invalid identifier/);
  });

  it("reports the database file path, and null for in-memory databases", async () => {
    const fileDb = await freshDb("dbname");
    const adapter = createSqliteAdapter();
    expect(await adapter.currentDatabaseName(fileDb.db)).toBe(fileDb.dbPath);

    const memoryClient = new Database(":memory:");
    const memoryDb: SqliteDatabase = drizzle(memoryClient);
    expect(await adapter.currentDatabaseName(memoryDb)).toBeNull();
  });

  it(
    "applies two migrations, records executed origins, and is a no-op on the second run",
    async () => {
      const env = await freshDb(
        "happy",
        {
          "0001_users.sql":
            "CREATE TABLE users (id integer PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO users (id) VALUES (1);",
          "0002_index.sql": "CREATE INDEX users_id_idx ON users (id);",
        },
        ["0.0.1", "0.0.2"],
      );
      const migrations = [
        defineMigration({
          version: "0.0.1",
          name: "users",
          sqlFiles: ["0001_users.sql"],
          async up(ctx) {
            await ctx.runSqlFile("0001_users.sql");
          },
        }),
        defineMigration({
          version: "0.0.2",
          name: "users-index",
          sqlFiles: ["0002_index.sql"],
          async up(ctx) {
            await ctx.runSqlFile("0002_index.sql");
          },
        }),
      ];

      const first = await runMigrations({
        adapter: sqliteDialect,
        db: env.db,
        config: env.config,
        migrations,
      });
      expect(first.applied).toEqual(["0.0.1", "0.0.2"]);

      const counts = await env.db.all<{ count: number }>(sql`SELECT count(*) AS count FROM users`);
      expect(counts[0]?.count).toBe(1);

      const { versions } = createTrackingTables(env.config);
      const rows = await env.db.select().from(versions);
      expect(rows.map((row) => [row.version, row.origin])).toEqual([
        ["0.0.1", "executed"],
        ["0.0.2", "executed"],
      ]);
      expect(rows[0]?.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const second = await runMigrations({
        adapter: sqliteDialect,
        db: env.db,
        config: env.config,
        migrations,
      });
      expect(second).toEqual({ applied: [], skipped: ["0.0.1", "0.0.2"], dryRun: [] });
    },
    TIMEOUT,
  );

  it(
    "serializes two concurrent migrators on one database file via the write lock",
    async () => {
      const env = await freshDb(
        "concurrent",
        {
          "0001_a.sql": "CREATE TABLE ca (id integer);",
          "0002_b.sql": "CREATE TABLE cb (id integer);",
        },
        ["0.0.1", "0.0.2"],
      );
      const config = defineConfig({
        ...env.config,
        lockName: "test:concurrent:migrations",
        lock: { waitTimeoutMs: 15_000, retryIntervalMs: 100 },
      });
      const secondDrizzle: SqliteDatabase = drizzle(new Database(env.dbPath));

      const migrations = [
        defineMigration({
          version: "0.0.1",
          name: "a",
          sqlFiles: ["0001_a.sql"],
          async up(ctx) {
            await ctx.runSqlFile("0001_a.sql");
          },
        }),
        defineMigration({
          version: "0.0.2",
          name: "b",
          sqlFiles: ["0002_b.sql"],
          async up(ctx) {
            await ctx.runSqlFile("0002_b.sql");
          },
        }),
      ];

      const [first, second] = await Promise.all([
        runMigrations({ adapter: sqliteDialect, db: env.db, config, migrations }),
        runMigrations({ adapter: sqliteDialect, db: secondDrizzle, config, migrations }),
      ]);

      expect([first.applied.length, second.applied.length].sort()).toEqual([0, 2]);
      const winner = first.applied.length > 0 ? first : second;
      expect(winner.applied).toEqual(["0.0.1", "0.0.2"]);
      expect(winner.skipped).toEqual([]);
      secondDrizzle.$client.close();
    },
    TIMEOUT,
  );

  it(
    "times out acquireLock while another writer holds the file, then succeeds after release",
    async () => {
      const env = await freshDb("lock-timeout");
      const adapter = createSqliteAdapter();

      const holder = new Database(env.dbPath);
      holder.exec("BEGIN IMMEDIATE");
      await expect(
        adapter.acquireLock(env.db, "test:lock:busy", {
          waitTimeoutMs: 400,
          retryIntervalMs: 50,
        }),
      ).rejects.toThrow(/could not acquire the sqlite write lock "test:lock:busy"/);
      holder.exec("COMMIT");
      holder.close();

      await adapter.acquireLock(env.db, "test:lock:busy", {
        waitTimeoutMs: 5_000,
        retryIntervalMs: 50,
      });
      expect(env.db.$client.inTransaction).toBe(true);
      await adapter.releaseLock(env.db, "test:lock:busy");
      expect(env.db.$client.inTransaction).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "rolls back the migration transaction savepoint on failure",
    async () => {
      const env = await freshDb("rollback");
      const adapter = createSqliteAdapter();

      await expect(
        adapter.runInTransaction(env.db, async () => {
          await adapter.executeRaw(env.db, "CREATE TABLE rb (id integer)");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const tables = await env.db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rb'`,
      );
      expect(tables).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "surfaces a killed migrator through status (stuck run.started)",
    async () => {
      const env = await freshDb("killed", { "0001_x.sql": "CREATE TABLE kx (id integer);" }, [
        "0.0.1",
      ]);
      const migrations = [
        defineMigration({
          version: "0.0.1",
          name: "x",
          sqlFiles: ["0001_x.sql"],
          async up(ctx) {
            await ctx.runSqlFile("0001_x.sql");
          },
        }),
      ];
      await runMigrations({ adapter: sqliteDialect, db: env.db, config: env.config, migrations });

      const adapter = createSqliteAdapter();
      await adapter.appendLog(env.db, env.config, {
        kind: "run.started",
        version: "0.0.9",
        runId: "killed-run-id",
        payload: { name: "killed-run" },
      });

      const report = await getStatus({
        adapter: sqliteDialect,
        db: env.db,
        config: env.config,
        migrations,
      });
      expect(report.currentVersion).toBe("0.0.1");
      expect(report.recentLogs).toContainEqual(
        expect.objectContaining({ kind: "run.started", version: "0.0.9" }),
      );
    },
    TIMEOUT,
  );

  it(
    "runs the DDL → raw backfill → DDL flow in one transaction",
    async () => {
      const env = await freshDb(
        "remap",
        {
          "0001_items.sql":
            "CREATE TABLE items (id integer PRIMARY KEY, label text);\n--> statement-breakpoint\nCREATE UNIQUE INDEX items_label_idx ON items (label);",
        },
        ["0.0.1"],
      );
      const migrations = [
        defineMigration({
          version: "0.0.1",
          name: "items",
          sqlFiles: ["0001_items.sql"],
          async up(ctx) {
            await ctx.runSqlFile("0001_items.sql", { to: 1 });
            await ctx.execute("INSERT INTO items (id, label) VALUES (1, 'A'), (2, 'B')");
            await ctx.runSqlFile("0001_items.sql", { from: 1 });
          },
        }),
      ];

      await runMigrations({ adapter: sqliteDialect, db: env.db, config: env.config, migrations });

      const rows = await env.db.all<{ id: number; label: string }>(
        sql`SELECT id, label FROM items ORDER BY id`,
      );
      expect(rows).toEqual([
        { id: 1, label: "A" },
        { id: 2, label: "B" },
      ]);
      let insertError: unknown;
      try {
        env.db.run(sql`INSERT INTO items (id, label) VALUES (3, 'A')`);
      } catch (error) {
        insertError = error;
      }
      expect(insertError).toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringMatching(/UNIQUE constraint failed/),
        }),
      });
    },
    TIMEOUT,
  );

  it(
    "fails the drift assertion when a column is added to the physical side only",
    async () => {
      const env = await freshDb("drift");
      await runMigrations({
        adapter: sqliteDialect,
        db: env.db,
        config: env.config,
        migrations: [],
      });

      env.client.exec(`ALTER TABLE "migration_versions" ADD COLUMN extra text`);
      await expect(
        runMigrations({ adapter: sqliteDialect, db: env.db, config: env.config, migrations: [] }),
      ).rejects.toThrow(
        /tracking table drift for migration_versions.*undeclared columns \[extra\]/s,
      );

      env.client.exec(`ALTER TABLE "migration_versions" DROP COLUMN extra`);
      env.client.exec(`ALTER TABLE "migration_versions" DROP COLUMN origin`);
      await expect(
        runMigrations({ adapter: sqliteDialect, db: env.db, config: env.config, migrations: [] }),
      ).rejects.toThrow(/missing columns \[origin\]/s);
    },
    TIMEOUT,
  );

  describe("adopt guards", () => {
    let env: Fixture;
    let dbName: string;
    let migrations: Migration[];

    beforeAll(async () => {
      env = await freshDb("adopt");
      const adapter = createSqliteAdapter();
      const detected = await adapter.currentDatabaseName(env.db);
      dbName = detected ?? "";
      migrations = [
        defineMigration({ version: "0.0.1", name: "one", up: async () => {} }),
        defineMigration({ version: "0.0.2", name: "two", up: async () => {} }),
        defineMigration({ version: "0.0.3", name: "three", up: async () => {} }),
        defineMigration({ version: "0.0.4", name: "four", up: async () => {} }),
      ];
    }, TIMEOUT);

    function adopt(options: Partial<Parameters<typeof adoptMigrations>[0]> = {}) {
      return adoptMigrations({
        adapter: sqliteDialect,
        db: env.db,
        config: env.config,
        migrations,
        confirmDatabase: dbName,
        ...options,
      });
    }

    it("refuses a database with no tables in its default schema", async () => {
      await expect(adopt()).rejects.toThrow(
        /no tables in its default schema.*run migrate instead/s,
      );
    });

    it("refuses to run when the CI env var is set", async () => {
      env.client.exec("CREATE TABLE preexisting (id integer)");
      process.env.CI = "1";
      await expect(adopt()).rejects.toThrow(/CI env var/);
      Reflect.deleteProperty(process.env, "CI");
    });

    it("refuses a wrong --confirm-database", async () => {
      await expect(adopt({ confirmDatabase: "some_other_db" })).rejects.toThrow(
        /--confirm-database mismatch.*"some_other_db"/s,
      );
    });

    it("rejects an unknown from version with the registry listed", async () => {
      await expect(adopt({ from: "9.9.9" })).rejects.toThrow(
        /unknown "from" version "9\.9\.9".*0\.0\.1, 0\.0\.2, 0\.0\.3, 0\.0\.4/s,
      );
    });

    it("adopts the requested range with origin adopted", async () => {
      const result = await adopt({ to: "0.0.2" });
      expect(result).toEqual({ adopted: ["0.0.1", "0.0.2"], notAdopted: ["0.0.3", "0.0.4"] });

      const { versions } = createTrackingTables(env.config);
      const rows = await env.db.select().from(versions);
      expect(rows.map((row) => [row.version, row.origin])).toEqual([
        ["0.0.1", "adopted"],
        ["0.0.2", "adopted"],
      ]);
    });

    it("aborts without force when the versions table already has rows", async () => {
      await expect(adopt()).rejects.toThrow(/already has rows.*force.*0\.0\.2/s);
      const { versions } = createTrackingTables(env.config);
      expect((await env.db.select().from(versions)).length).toBe(2);
    });

    it("with force, continues above the highest recorded version", async () => {
      const forced = await adopt({ to: "0.0.4", force: true });
      expect(forced).toEqual({ adopted: ["0.0.3", "0.0.4"], notAdopted: [] });

      const { versions } = createTrackingTables(env.config);
      const rows = await env.db.select().from(versions);
      expect(rows.map((row) => [row.version, row.origin])).toEqual([
        ["0.0.1", "adopted"],
        ["0.0.2", "adopted"],
        ["0.0.3", "adopted"],
        ["0.0.4", "adopted"],
      ]);
    });

    it("with force and to not above the highest recorded version, exits cleanly", async () => {
      const result = await adopt({ to: "0.0.2", force: true });
      expect(result).toEqual({ adopted: [], notAdopted: ["0.0.3", "0.0.4"] });
    });

    it("rejects from above to", async () => {
      await expect(adopt({ from: "0.0.4", to: "0.0.1", force: true })).rejects.toThrow(
        /"from" \(0\.0\.4\) is above "to" \(0\.0\.1\)/,
      );
    });
  });

  it(
    "getStatus reports an empty, freshly-bootstrapped database",
    async () => {
      const env = await freshDb("status-empty");
      await runMigrations({
        adapter: sqliteDialect,
        db: env.db,
        config: env.config,
        migrations: [],
      });
      const report = await getStatus({
        adapter: sqliteDialect,
        db: env.db,
        config: env.config,
        migrations: [],
      });
      expect(report.currentVersion).toBeNull();
      expect(report.applied).toEqual([]);
      expect(report.pending).toEqual([]);
      expect(report.recentLogs.length).toBeGreaterThan(0);
      expect(report.recentLogs.map((row) => row.kind)).toContain("bootstrap.completed");
    },
    TIMEOUT,
  );
});
