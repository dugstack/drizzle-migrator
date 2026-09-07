import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/core/config.js";
import { adoptMigrations, getStatus, runMigrations } from "../src/core/engine.js";
import { defineMigration } from "../src/core/index.js";
import { compareVersions, validateRegistry } from "../src/core/registry.js";
import { sliceStatements, splitStatements } from "../src/core/sql.js";
import {
  type FakeDatabase,
  createFakeAdapter,
  createFakeDatabase,
  createFakeLogger,
} from "./fake-adapter.js";

type Setup = Awaited<ReturnType<typeof setup>>;

type SetupOptions = {
  versions?: string[];
  sqlFiles?: Record<string, string>;
  db?: Partial<FakeDatabase>;
};

async function setup(options: SetupOptions = {}) {
  const tmp = await mkdtemp(join(tmpdir(), "drizzle-migrator-test-"));
  const sqlDir = join(tmp, "sql");
  const migrationsDir = join(tmp, "versions");
  await mkdir(sqlDir);
  await mkdir(migrationsDir);

  for (const [name, content] of Object.entries(options.sqlFiles ?? {})) {
    await writeFile(join(sqlDir, name), content, "utf8");
  }
  for (const version of options.versions ?? []) {
    const folder = join(migrationsDir, `v${version}`);
    await mkdir(folder);
    await writeFile(join(folder, "index.ts"), "export const placeholder = true;\n", "utf8");
  }

  const logger = createFakeLogger();
  const db = createFakeDatabase(options.db);
  const adapter = createFakeAdapter(db);
  const config = defineConfig({ sqlDir, migrationsDir, lockName: "test:db:migrations", logger });
  return { tmp, sqlDir, migrationsDir, db, adapter, config, logger };
}

const TWO_STATEMENTS =
  "CREATE TABLE a (x int);\n--> statement-breakpoint\nCREATE TABLE b (y int);\n";

function loggedKinds(setupResult: Setup): string[] {
  return setupResult.db.logs.map((entry) => entry.kind);
}

function registryEntry(name: string, version: string, sqlFiles: string[] = []) {
  return defineMigration({
    version,
    name,
    ...(sqlFiles.length > 0 ? { sqlFiles } : {}),
    up: async () => {},
  });
}

afterEach(() => {
  Reflect.deleteProperty(process.env, "CI");
});

describe("sql splitting and ranges", () => {
  it("splits on statement-breakpoint markers and skips empty statements", () => {
    const statements = splitStatements(`${TWO_STATEMENTS}--> statement-breakpoint\n   \n`);
    expect(statements).toEqual(["CREATE TABLE a (x int);", "CREATE TABLE b (y int);"]);
  });

  it("slices with from inclusive and to exclusive", () => {
    const statements = ["s0", "s1", "s2", "s3"];
    expect(sliceStatements(statements)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(sliceStatements(statements, { from: 1 })).toEqual(["s1", "s2", "s3"]);
    expect(sliceStatements(statements, { to: 2 })).toEqual(["s0", "s1"]);
    expect(sliceStatements(statements, { from: 1, to: 3 })).toEqual(["s1", "s2"]);
    expect(sliceStatements(statements, { from: 2, to: 2 })).toEqual([]);
  });

  it("rejects invalid ranges before anything executes", () => {
    const statements = ["s0", "s1"];
    expect(() => sliceStatements(statements, { from: -1 })).toThrow(
      /"from" must be a non-negative integer/,
    );
    expect(() => sliceStatements(statements, { from: 2, to: 1 })).toThrow(/must not be less than/);
    expect(() => sliceStatements(statements, { to: 3 })).toThrow(/exceeds statement count/);
    expect(() => sliceStatements(statements, { from: 1.5 })).toThrow(
      /"from" must be a non-negative integer/,
    );
  });
});

describe("registry validation", () => {
  it("sorts numerically by semver (0.10.0 after 0.9.0)", async () => {
    const env = await setup({ versions: ["0.9.0", "0.10.0", "0.0.2"] });
    const sorted = await validateRegistry(
      [registryEntry("b", "0.10.0"), registryEntry("a", "0.9.0"), registryEntry("c", "0.0.2")],
      env.config,
    );
    expect(sorted.map((migration) => migration.version)).toEqual(["0.0.2", "0.9.0", "0.10.0"]);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });

  it("rejects malformed versions", async () => {
    const env = await setup({ versions: ["0.0.1"] });
    await expect(validateRegistry([registryEntry("bad", "0.0")], env.config)).rejects.toThrow(
      /must match/,
    );
  });

  it("rejects duplicate versions", async () => {
    const env = await setup({ versions: ["0.0.1"] });
    await expect(
      validateRegistry(
        [registryEntry("one", "0.0.1"), registryEntry("another", "0.0.1")],
        env.config,
      ),
    ).rejects.toThrow(/duplicate version 0\.0\.1.*"one".*"another"/s);
  });

  it("rejects duplicate sqlFiles across migrations, listing clashing versions", async () => {
    const env = await setup({ versions: ["0.0.1", "0.0.2"], sqlFiles: { "0001.sql": "S;" } });
    await expect(
      validateRegistry(
        [registryEntry("one", "0.0.1", ["0001.sql"]), registryEntry("two", "0.0.2", ["0001.sql"])],
        env.config,
      ),
    ).rejects.toThrow(/declared by multiple migrations.*one.*two/s);
  });

  it("rejects sqlFiles missing on disk", async () => {
    const env = await setup({ versions: ["0.0.1"] });
    await expect(
      validateRegistry([registryEntry("one", "0.0.1", ["missing.sql"])], env.config),
    ).rejects.toThrow(/not found under/);
  });

  it("rejects entries whose folder is not exactly v + version", async () => {
    const env = await setup({ versions: ["0.0.2"] });
    await expect(validateRegistry([registryEntry("drifted", "0.0.9")], env.config)).rejects.toThrow(
      /no folder "v0\.0\.9".*must be exactly "v" \+ the version field/s,
    );
  });

  it("rejects flat <version>.ts files in migrationsDir", async () => {
    const env = await setup({ versions: ["0.0.1"] });
    await writeFile(join(env.migrationsDir, "0.0.5.ts"), "export const x = 1;\n", "utf8");
    await expect(validateRegistry([registryEntry("one", "0.0.1")], env.config)).rejects.toThrow(
      /flat file "0\.0\.5\.ts"/,
    );
  });

  it("aggregates all reasons into one error", async () => {
    const env = await setup({ versions: ["0.0.1"] });
    await expect(
      validateRegistry(
        [registryEntry("bad-format", "0.0"), registryEntry("no-folder", "0.9.9")],
        env.config,
      ),
    ).rejects.toThrow(/- migration "bad-format".*- migration 0\.9\.9/s);
  });
});

describe("runMigrations against the fake adapter", () => {
  let env: Setup;

  const migrations = [
    defineMigration({
      version: "0.0.1",
      name: "first",
      sqlFiles: ["0001_a.sql"],
      async up(ctx) {
        await ctx.runSqlFile("0001_a.sql");
      },
    }),
    defineMigration({
      version: "0.0.2",
      name: "second",
      sqlFiles: ["0002_b.sql"],
      async up(ctx) {
        await ctx.runSqlFile("0002_b.sql");
      },
    }),
  ];

  beforeEach(async () => {
    env = await setup({
      sqlFiles: { "0001_a.sql": TWO_STATEMENTS, "0002_b.sql": "CREATE TABLE c (z int);" },
      versions: ["0.0.1", "0.0.2"],
    });
  });

  it("applies pending migrations in semver order and records version rows inside the transaction", async () => {
    const result = await runMigrations({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations,
    });

    expect(result).toEqual({ applied: ["0.0.1", "0.0.2"], skipped: [], dryRun: [] });
    expect(env.db.versions.map((row) => [row.version, row.origin])).toEqual([
      ["0.0.1", "executed"],
      ["0.0.2", "executed"],
    ]);
    expect(env.db.executedStatements).toEqual([
      "CREATE TABLE a (x int);",
      "CREATE TABLE b (y int);",
      "CREATE TABLE c (z int);",
    ]);
  });

  it("emits the full engine audit trail", async () => {
    await runMigrations({ db: env.db, adapter: env.adapter, config: env.config, migrations });
    expect(loggedKinds(env)).toEqual([
      "lock.acquired",
      "bootstrap.completed",
      "run.started",
      "run.applied",
      "run.started",
      "run.applied",
      "lock.released",
    ]);
    expect(env.db.locked).toBe(false);
  });

  it("is a no-op on the second run", async () => {
    await runMigrations({ db: env.db, adapter: env.adapter, config: env.config, migrations });
    const logsAfterFirstRun = env.db.logs.length;
    const second = await runMigrations({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations,
    });

    expect(second).toEqual({ applied: [], skipped: ["0.0.1", "0.0.2"], dryRun: [] });
    expect(env.db.versions).toHaveLength(2);
    expect(env.db.logs.slice(logsAfterFirstRun).map((entry) => entry.kind)).not.toContain(
      "run.started",
    );
  });

  it("rolls back the whole migration on mid-migration failure and keeps run.failed outside the tx", async () => {
    env.db.failingStatement = "FAIL_MARKER";
    await mkdir(join(env.migrationsDir, "v0.0.3"));
    const failing = [
      migrations[0] ?? undefined,
      defineMigration({
        version: "0.0.3",
        name: "boom",
        async up(ctx) {
          await ctx.execute("SELECT 1");
          await ctx.execute("SELECT FAIL_MARKER");
        },
      }),
    ].filter((migration) => migration !== undefined);

    await expect(
      runMigrations({ db: env.db, adapter: env.adapter, config: env.config, migrations: failing }),
    ).rejects.toThrow(/FAIL_MARKER/);

    expect(env.db.versions.map((row) => row.version)).toEqual(["0.0.1"]);
    const kinds = loggedKinds(env);
    expect(kinds).toContain("run.started");
    expect(kinds).toContain("run.failed");
    expect(
      env.db.logs.some((entry) => entry.kind === "run.applied" && entry.version === "0.0.3"),
    ).toBe(false);
    const failed = env.db.logs.find((entry) => entry.kind === "run.failed");
    expect(failed?.detail).toContain("fake executeRaw failed");
    expect(env.db.executedStatements).toEqual([
      "CREATE TABLE a (x int);",
      "CREATE TABLE b (y int);",
    ]);
    expect(env.db.locked).toBe(false);
  });

  it("rolls back ctx.audit events with the transaction", async () => {
    env.db.failingStatement = "FAIL_MARKER";
    const failing = [
      defineMigration({
        version: "0.0.1",
        name: "audit-then-boom",
        async up(ctx) {
          await ctx.audit("backfill.progress", { rows: 1234 });
          await ctx.execute("SELECT FAIL_MARKER");
        },
      }),
    ];

    await expect(
      runMigrations({ db: env.db, adapter: env.adapter, config: env.config, migrations: failing }),
    ).rejects.toThrow(/FAIL_MARKER/);

    expect(loggedKinds(env)).not.toContain("backfill.progress");
    expect(loggedKinds(env)).toContain("run.failed");
  });

  it("honors runSqlFile ranges (from inclusive, to exclusive)", async () => {
    const ranged = [
      defineMigration({
        version: "0.0.1",
        name: "ranged",
        sqlFiles: ["0001_a.sql"],
        async up(ctx) {
          await ctx.runSqlFile("0001_a.sql", { from: 1, to: 2 });
        },
      }),
    ];

    await runMigrations({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations: ranged,
    });
    expect(env.db.executedStatements).toEqual(["CREATE TABLE b (y int);"]);
  });

  it("refuses to run an undeclared SQL file at runtime", async () => {
    const sneaky = [
      defineMigration({
        version: "0.0.1",
        name: "sneaky",
        async up(ctx) {
          await (ctx.runSqlFile as (file: string) => Promise<void>)("0001_a.sql");
        },
      }),
    ];

    await expect(
      runMigrations({ db: env.db, adapter: env.adapter, config: env.config, migrations: sneaky }),
    ).rejects.toThrow(/is not declared by migration 0\.0\.1/);
  });

  it("dry-run previews statements without executing or recording anything", async () => {
    const result = await runMigrations({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations,
      dryRun: true,
    });

    expect(result).toEqual({ applied: [], skipped: [], dryRun: ["0.0.1", "0.0.2"] });
    expect(env.db.versions).toHaveLength(0);
    expect(env.db.executedStatements).toHaveLength(0);
    expect(loggedKinds(env)).toEqual(["dryrun.completed"]);
    expect(env.logger.lines.join("\n")).toContain("0001_a.sql: 2 statement(s)");
    expect(env.db.locked).toBe(false);
  });

  it("emits lock.timeout and rethrows when the lock cannot be acquired", async () => {
    env.db.lockShouldFail = true;
    await expect(
      runMigrations({
        db: env.db,
        adapter: env.adapter,
        config: env.config,
        migrations,
      }),
    ).rejects.toThrow(/lock wait timed out/);
    expect(loggedKinds(env)).toEqual(["lock.timeout"]);
    expect(env.db.versions).toHaveLength(0);
  });
});

describe("getStatus against the fake adapter", () => {
  it("reports an empty database", async () => {
    const env = await setup();
    const report = await getStatus({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations: [],
    });

    expect(report.currentVersion).toBeNull();
    expect(report.applied).toEqual([]);
    expect(report.pending).toEqual([]);
    expect(report.recentLogs).toEqual([]);
  });

  it("reports applied rows, pending entries, and recent logs newest-first", async () => {
    const env = await setup({ versions: ["0.0.1", "0.0.2"], sqlFiles: { "0001_a.sql": "S;" } });
    const migrations = [
      defineMigration({
        version: "0.0.1",
        name: "first",
        sqlFiles: ["0001_a.sql"],
        async up(ctx) {
          await ctx.runSqlFile("0001_a.sql");
        },
      }),
      defineMigration({ version: "0.0.2", name: "second", up: async () => {} }),
    ];
    await runMigrations({ db: env.db, adapter: env.adapter, config: env.config, migrations });

    const report = await getStatus({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations,
    });
    expect(report.currentVersion).toBe("0.0.2");
    expect(report.applied.map((row) => row.version)).toEqual(["0.0.1", "0.0.2"]);
    expect(report.applied[0]).toMatchObject({ origin: "executed" });
    expect(typeof report.applied[0]?.appliedAt).toBe("string");
    expect(report.pending).toEqual([]);
    expect(report.recentLogs[0]?.kind).toBe("lock.released");
    expect(report.recentLogs).toContainEqual(
      expect.objectContaining({ kind: "run.applied", version: "0.0.2" }),
    );
  });
});

describe("adoptMigrations against the fake adapter", () => {
  const migrations = [
    defineMigration({ version: "0.0.1", name: "one", up: async () => {} }),
    defineMigration({ version: "0.0.2", name: "two", up: async () => {} }),
    defineMigration({ version: "0.0.3", name: "three", up: async () => {} }),
    defineMigration({ version: "0.0.4", name: "four", up: async () => {} }),
  ];

  function adoptSetup(dbOverrides: Partial<FakeDatabase> = {}) {
    return setup({ versions: ["0.0.1", "0.0.2", "0.0.3", "0.0.4"], db: dbOverrides });
  }

  function seedExecuted(env: Setup, versions: string[]) {
    for (const version of versions) {
      env.db.versions.push({
        version,
        name: version,
        origin: "executed",
        appliedAt: new Date().toISOString(),
      });
    }
  }

  it("adopts a fresh database across the full registry range by default", async () => {
    const env = await adoptSetup();
    const result = await adoptMigrations({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations,
      confirmDatabase: "fake_db",
    });

    expect(result).toEqual({ adopted: ["0.0.1", "0.0.2", "0.0.3", "0.0.4"], notAdopted: [] });
    expect(env.db.versions.map((row) => [row.version, row.origin])).toEqual([
      ["0.0.1", "adopted"],
      ["0.0.2", "adopted"],
      ["0.0.3", "adopted"],
      ["0.0.4", "adopted"],
    ]);
    expect(loggedKinds(env).filter((kind) => kind === "run.adopted")).toHaveLength(4);
  });

  it("rejects unknown from/to with the registry listed", async () => {
    const env = await adoptSetup();
    await expect(
      adoptMigrations({
        db: env.db,
        adapter: env.adapter,
        config: env.config,
        migrations,
        from: "0.9.9",
        confirmDatabase: "fake_db",
      }),
    ).rejects.toThrow(/unknown "from" version "0\.9\.9".*0\.0\.1, 0\.0\.2, 0\.0\.3, 0\.0\.4/s);
    expect(env.db.versions).toHaveLength(0);
  });

  it("rejects a wrong --confirm-database", async () => {
    const env = await adoptSetup();
    await expect(
      adoptMigrations({
        db: env.db,
        adapter: env.adapter,
        config: env.config,
        migrations,
        confirmDatabase: "other_db",
      }),
    ).rejects.toThrow(/--confirm-database mismatch.*"other_db"/s);
    expect(env.db.versions).toHaveLength(0);
  });

  it("refuses a database with no tables in its default schema", async () => {
    const env = await adoptSetup({ defaultSchemaTables: [] });
    await expect(
      adoptMigrations({
        db: env.db,
        adapter: env.adapter,
        config: env.config,
        migrations,
        confirmDatabase: "fake_db",
      }),
    ).rejects.toThrow(/no tables in its default schema.*run migrate instead/s);
    expect(env.db.versions).toHaveLength(0);
  });

  it("refuses to run when the CI env var is set", async () => {
    const env = await adoptSetup();
    process.env.CI = "1";
    await expect(
      adoptMigrations({
        db: env.db,
        adapter: env.adapter,
        config: env.config,
        migrations,
        confirmDatabase: "fake_db",
      }),
    ).rejects.toThrow(/CI env var/);
    expect(env.db.versions).toHaveLength(0);
  });

  it("aborts without force when versions already exist", async () => {
    const env = await adoptSetup();
    seedExecuted(env, ["0.0.1"]);

    await expect(
      adoptMigrations({
        db: env.db,
        adapter: env.adapter,
        config: env.config,
        migrations,
        confirmDatabase: "fake_db",
      }),
    ).rejects.toThrow(/already has rows.*force.*0\.0\.1/s);
    expect(env.db.versions).toHaveLength(1);
  });

  it("with force, the effective range starts above the highest recorded version", async () => {
    const env = await adoptSetup();
    seedExecuted(env, ["0.0.1", "0.0.2"]);

    const result = await adoptMigrations({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations,
      from: "0.0.1",
      to: "0.0.4",
      force: true,
      confirmDatabase: "fake_db",
    });

    expect(result).toEqual({ adopted: ["0.0.3", "0.0.4"], notAdopted: [] });
    expect(
      env.db.versions.filter((row) => row.origin === "adopted").map((row) => row.version),
    ).toEqual(["0.0.3", "0.0.4"]);
  });

  it("with force and to not above the highest recorded version, exits cleanly", async () => {
    const env = await adoptSetup();
    seedExecuted(env, ["0.0.1", "0.0.2", "0.0.3"]);

    const result = await adoptMigrations({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations,
      to: "0.0.2",
      force: true,
      confirmDatabase: "fake_db",
    });

    expect(result).toEqual({ adopted: [], notAdopted: ["0.0.3", "0.0.4"] });
    expect(env.db.versions.filter((row) => row.origin === "adopted")).toHaveLength(0);
  });

  it("reports notAdopted for versions above to", async () => {
    const env = await adoptSetup();
    const result = await adoptMigrations({
      db: env.db,
      adapter: env.adapter,
      config: env.config,
      migrations,
      to: "0.0.2",
      confirmDatabase: "fake_db",
    });

    expect(result).toEqual({ adopted: ["0.0.1", "0.0.2"], notAdopted: ["0.0.3", "0.0.4"] });
  });
});
