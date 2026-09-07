import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Migration, defineConfig, defineMigration } from "../src/core/index.js";
import { type PgDatabase, createPgAdapter } from "../src/pg/adapter.js";
import { adoptMigrations, getStatus, runMigrations } from "../src/pg/index.js";
import { createTrackingTables } from "../src/pg/tables.js";
import { createFakeLogger } from "./fake-adapter.js";

const TIMEOUT = 120_000;
const PG_IMAGE = "postgres:16-alpine";

async function dockerReachable(): Promise<boolean> {
  const host = process.env.DOCKER_HOST;
  if (host && !host.startsWith("unix://")) {
    return true;
  }
  const socketPath = host?.startsWith("unix://")
    ? host.slice("unix://".length)
    : "/var/run/docker.sock";
  try {
    await access(socketPath);
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const socket = netConnect({ path: socketPath });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(2000);
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const dockerAvailable = await dockerReachable();
if (!dockerAvailable) {
  console.warn(
    "[pg.integration] Docker is not reachable — skipping testcontainers integration tests (CI runs them with Docker).",
  );
}

const suite = describe.skipIf(!dockerAvailable);

suite("pg integration (testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let adminClient: Client;
  const clients: Client[] = [];
  let tmpBase: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(PG_IMAGE).start();
    adminClient = new Client({ connectionString: container.getConnectionUri() });
    await adminClient.connect();
    tmpBase = await mkdtemp(join(tmpdir(), "drizzle-migrator-pg-"));
  }, TIMEOUT);

  afterAll(async () => {
    for (const client of clients) {
      await client.end().catch(() => {});
    }
    await adminClient.end().catch(() => {});
    await container.stop().catch(() => {});
  }, TIMEOUT);

  afterEach(() => {
    Reflect.deleteProperty(process.env, "CI");
  });

  type Fixture = {
    db: PgDatabase;
    client: Client;
    config: ReturnType<typeof defineConfig>;
    uri: string;
  };

  async function freshDb(
    name: string,
    sqlFiles: Record<string, string> = {},
    versions: string[] = [],
  ): Promise<Fixture> {
    await adminClient.query(`CREATE DATABASE "${name}"`);
    const uri = new URL(container.getConnectionUri());
    uri.pathname = `/${name}`;
    const connectionString = uri.toString();
    const client = new Client({ connectionString });
    await client.connect();
    clients.push(client);

    const sqlDir = join(tmpBase, name, "sql");
    const migrationsDir = join(tmpBase, name, "versions");
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
    const db: PgDatabase = drizzle(client);
    return { db, client, config, uri: connectionString };
  }

  it("validates identifiers per §9 before anything touches SQL", () => {
    const adapter = createPgAdapter();
    expect(adapter.id).toBe("pg");
    expect(adapter.quoteIdentifier("ok_name1")).toBe('"ok_name1"');
    expect(() => adapter.quoteIdentifier('bad"name')).toThrow(/invalid identifier/);
    expect(() => adapter.quoteIdentifier("UPPER")).toThrow(/invalid identifier/);
    expect(() => adapter.quoteIdentifier("1leading")).toThrow(/invalid identifier/);
    expect(() => adapter.quoteIdentifier("semi;colon")).toThrow(/invalid identifier/);
  });

  it(
    "applies two migrations, records executed origins, and is a no-op on the second run",
    async () => {
      const env = await freshDb(
        "happy",
        {
          "0001_users.sql":
            "CREATE TABLE users (id int PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO users (id) VALUES (1);",
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

      const first = await runMigrations({ db: env.db, config: env.config, migrations });
      expect(first.applied).toEqual(["0.0.1", "0.0.2"]);

      const userCount = await env.db.execute(sql`SELECT count(*)::int AS count FROM users`);
      expect((userCount.rows[0] as { count: number }).count).toBe(1);

      const { versions } = createTrackingTables(env.config);
      const rows = await env.db.select().from(versions);
      expect(rows.map((row) => [row.version, row.origin])).toEqual([
        ["0.0.1", "executed"],
        ["0.0.2", "executed"],
      ]);
      expect(rows[0]?.appliedAt).toBeInstanceOf(Date);

      const second = await runMigrations({ db: env.db, config: env.config, migrations });
      expect(second).toEqual({ applied: [], skipped: ["0.0.1", "0.0.2"], dryRun: [] });
    },
    TIMEOUT,
  );

  it(
    "serializes two concurrent migrators on one database via the advisory lock",
    async () => {
      const env = await freshDb(
        "concurrent",
        {
          "0001_a.sql": "CREATE TABLE ca (id int);",
          "0002_b.sql": "CREATE TABLE cb (id int);",
        },
        ["0.0.1", "0.0.2"],
      );
      const config = defineConfig({
        ...env.config,
        lockName: "test:concurrent:migrations",
        lock: { waitTimeoutMs: 15_000, retryIntervalMs: 100 },
      });
      const secondClient = new Client({ connectionString: env.uri });
      await secondClient.connect();
      clients.push(secondClient);
      const secondDrizzle: PgDatabase = drizzle(secondClient);

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
        runMigrations({ db: env.db, config, migrations }),
        runMigrations({ db: secondDrizzle, config, migrations }),
      ]);

      expect([first.applied.length, second.applied.length].sort()).toEqual([0, 2]);
      const winner = first.applied.length > 0 ? first : second;
      expect(winner.applied).toEqual(["0.0.1", "0.0.2"]);
      expect(winner.skipped).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "surfaces a killed migrator through status (stuck run.started)",
    async () => {
      const env = await freshDb("killed", { "0001_x.sql": "CREATE TABLE kx (id int);" }, ["0.0.1"]);
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
      await runMigrations({ db: env.db, config: env.config, migrations });

      const adapter = createPgAdapter();
      await adapter.appendLog(env.db, env.config, {
        id: randomUUID(),
        kind: "run.started",
        version: "0.0.9",
        runId: randomUUID(),
        payload: { name: "killed-run" },
      });

      const report = await getStatus({ db: env.db, config: env.config, migrations });
      expect(report.currentVersion).toBe("0.0.1");
      expect(report.recentLogs).toContainEqual(
        expect.objectContaining({ kind: "run.started", version: "0.0.9" }),
      );
    },
    TIMEOUT,
  );

  it(
    "runs the DDL → raw backfill → DDL remap flow in one transaction",
    async () => {
      const env = await freshDb(
        "remap",
        {
          "0001_remap.sql":
            "CREATE TABLE items (id int, label text);\n--> statement-breakpoint\nALTER TABLE items ALTER COLUMN label SET NOT NULL;",
        },
        ["0.0.1"],
      );
      const migrations = [
        defineMigration({
          version: "0.0.1",
          name: "remap",
          sqlFiles: ["0001_remap.sql"],
          async up(ctx) {
            await ctx.runSqlFile("0001_remap.sql", { to: 1 });
            await ctx.execute("INSERT INTO items (id, label) VALUES (1, 'A'), (2, 'B')");
            await ctx.runSqlFile("0001_remap.sql", { from: 1 });
          },
        }),
      ];

      await runMigrations({ db: env.db, config: env.config, migrations });

      const rows = await env.db.execute(sql`SELECT id, label FROM items ORDER BY id`);
      expect(rows.rows).toEqual([
        { id: 1, label: "A" },
        { id: 2, label: "B" },
      ]);
      await expect(
        env.db.execute(sql`INSERT INTO items (id, label) VALUES (3, NULL)`),
      ).rejects.toThrow(/null value/i);
    },
    TIMEOUT,
  );

  it(
    "fails the drift assertion when a column is added to the physical side only",
    async () => {
      const env = await freshDb("drift");
      await runMigrations({ db: env.db, config: env.config, migrations: [] });

      await env.db.execute(
        sql`ALTER TABLE "migrations"."migration_versions" ADD COLUMN extra text`,
      );
      await expect(
        runMigrations({ db: env.db, config: env.config, migrations: [] }),
      ).rejects.toThrow(
        /tracking table drift for migrations\.migration_versions.*undeclared columns \[extra\]/s,
      );

      await env.db.execute(sql`ALTER TABLE "migrations"."migration_versions" DROP COLUMN extra`);
      await env.db.execute(sql`ALTER TABLE "migrations"."migration_versions" DROP COLUMN origin`);
      await expect(
        runMigrations({ db: env.db, config: env.config, migrations: [] }),
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
      const adapter = createPgAdapter();
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
      await env.db.execute(sql`CREATE TABLE preexisting (id int)`);
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
      await runMigrations({ db: env.db, config: env.config, migrations: [] });
      const report = await getStatus({ db: env.db, config: env.config, migrations: [] });
      expect(report.currentVersion).toBeNull();
      expect(report.applied).toEqual([]);
      expect(report.pending).toEqual([]);
      expect(report.recentLogs.length).toBeGreaterThan(0);
      expect(report.recentLogs.map((row) => row.kind)).toContain("bootstrap.completed");
    },
    TIMEOUT,
  );
});
