import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMigrator, defineConfig, defineMigration } from "../src/core/index.js";
import { mysqlDialect } from "../src/mysql/index.js";
import { sqliteDialect } from "../src/sqlite/index.js";
import { createFakeAdapter, createFakeDatabase, createFakeLogger } from "./fake-adapter.js";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "drizzle-migrator-factory-"));
  const sqlDir = join(root, "sql");
  const migrationsDir = join(root, "versions");
  await mkdir(sqlDir);
  await mkdir(migrationsDir);
  const db = createFakeDatabase();
  const logger = createFakeLogger();
  const config = defineConfig({
    sqlDir,
    migrationsDir,
    lockName: "factory:test:lock",
    logger,
  });
  return { root, sqlDir, migrationsDir, db, config, logger };
}

/** A valid single-migration registry fixture on disk (folder + SQL file). */
async function writeValidRegistry(fixture: {
  sqlDir: string;
  migrationsDir: string;
}): Promise<void> {
  await writeFile(join(fixture.sqlDir, "0001_a.sql"), "CREATE TABLE a (x int);", "utf8");
  const folder = join(fixture.migrationsDir, "v0.0.1");
  await mkdir(folder);
  await writeFile(join(folder, "index.ts"), "export const placeholder = true;\n", "utf8");
}

function migration0_0_1() {
  return defineMigration({
    version: "0.0.1",
    name: "first",
    sqlFiles: ["0001_a.sql"],
    up: async () => {},
  });
}

describe("createMigrator", () => {
  it("exposes every bound operation", async () => {
    const fixture = await createFixture();
    const migrator = createMigrator({
      dialect: createFakeAdapter(fixture.db),
      config: fixture.config,
      migrations: [],
    });

    expect(Object.keys(migrator).sort()).toEqual([
      "adoptMigrations",
      "appendAuditEvent",
      "generateMigrationEntry",
      "getStatus",
      "runMigrations",
      "suggestMigrationEntry",
      "validateMigrationEntries",
    ]);
    await expect(migrator.validateMigrationEntries()).resolves.toEqual({ ok: true, errors: [] });
    await expect(migrator.runMigrations({ db: fixture.db })).resolves.toMatchObject({
      applied: [],
    });
  });

  it.each([
    ["mysql", mysqlDialect],
    ["sqlite", sqliteDialect],
  ] as const)("keeps %s imports safe and throws from every adapter method", (id, dialect) => {
    for (const [name, member] of Object.entries(dialect)) {
      if (name === "id") {
        continue;
      }
      expect(() => (member as () => unknown)(), name).toThrow(
        `${id} adapter is not implemented in v1`,
      );
    }
  });

  it("delegates identifier validation to its dialect", async () => {
    const fixture = await createFixture();
    const dialect = createFakeAdapter(fixture.db);
    dialect.quoteIdentifier = (identifier) => {
      if (identifier === "BadSchema") {
        throw new Error("dialect rejected identifier");
      }
      return `"${identifier}"`;
    };

    expect(() =>
      createMigrator({
        dialect,
        config: { ...fixture.config, schema: "BadSchema" },
        migrations: [],
      }),
    ).toThrow("dialect rejected identifier");
  });
});

describe("migrator.validateMigrationEntries", () => {
  it("passes without a db and writes no audit rows", async () => {
    const fixture = await createFixture();
    await writeValidRegistry(fixture);
    const migrator = createMigrator({
      dialect: createFakeAdapter(fixture.db),
      config: fixture.config,
      migrations: [migration0_0_1()],
    });

    await expect(migrator.validateMigrationEntries()).resolves.toEqual({ ok: true, errors: [] });
    expect(fixture.db.logs).toHaveLength(0);
  });

  it("with a db, records validation.started then validation.completed with status passed", async () => {
    const fixture = await createFixture();
    await writeValidRegistry(fixture);
    const migrator = createMigrator({
      dialect: createFakeAdapter(fixture.db),
      config: fixture.config,
      migrations: [migration0_0_1()],
    });

    await expect(migrator.validateMigrationEntries({ db: fixture.db })).resolves.toEqual({
      ok: true,
      errors: [],
    });
    expect(fixture.db.logs.map((entry) => entry.kind)).toEqual([
      "validation.started",
      "validation.completed",
    ]);
    expect(fixture.db.logs[0]?.at).toBeDefined();
    expect(fixture.db.logs[1]?.at).toBeDefined();
    expect(fixture.db.logs[1]?.payload).toMatchObject({ status: "passed", migrations: 1 });
  });

  it("with a db, records validation.failed with the reason but preserves the errors", async () => {
    const fixture = await createFixture();
    const duplicate = [
      defineMigration({ version: "0.0.1", name: "one", up: async () => {} }),
      defineMigration({ version: "0.0.1", name: "another", up: async () => {} }),
    ];
    const migrator = createMigrator({
      dialect: createFakeAdapter(fixture.db),
      config: fixture.config,
      migrations: duplicate,
    });

    const result = await migrator.validateMigrationEntries({ db: fixture.db });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("duplicate version 0.0.1");
    expect(fixture.db.logs.map((entry) => entry.kind)).toEqual([
      "validation.started",
      "validation.failed",
    ]);
    expect(fixture.db.logs[1]?.payload).toMatchObject({ status: "failed" });
    expect(fixture.db.logs[1]?.detail).toContain("duplicate version 0.0.1");
  });

  it("ignores audit-write failures: the validation result survives", async () => {
    const fixture = await createFixture();
    await writeValidRegistry(fixture);
    const dialect = createFakeAdapter(fixture.db);
    dialect.appendLog = async () => {
      throw new Error("audit storage unavailable");
    };
    const migrator = createMigrator({
      dialect,
      config: fixture.config,
      migrations: [migration0_0_1()],
    });

    await expect(migrator.validateMigrationEntries({ db: fixture.db })).resolves.toEqual({
      ok: true,
      errors: [],
    });
    expect(fixture.logger.lines.join("\n")).toContain("failed to write audit event");
  });
});

describe("migrator.suggestMigrationEntry", () => {
  it("returns the domain defaults for the next entry", async () => {
    const fixture = await createFixture();
    const migrator = createMigrator({
      dialect: createFakeAdapter(fixture.db),
      config: fixture.config,
      migrations: [migration0_0_1()],
    });

    expect(migrator.suggestMigrationEntry()).toEqual({
      version: "0.0.2",
      name: "pending-migration",
    });
  });
});

describe("migrator.appendAuditEvent", () => {
  it("binds the configured audit storage to the supplied db handle", async () => {
    const fixture = await createFixture();
    const migrator = createMigrator({
      dialect: createFakeAdapter(fixture.db),
      config: fixture.config,
      migrations: [],
    });

    await migrator.appendAuditEvent({
      db: fixture.db,
      entry: { kind: "cli.command", payload: { command: "status", flags: {} } },
    });

    expect(fixture.db.logs).toHaveLength(1);
    const entry = fixture.db.logs[0];
    expect(entry?.kind).toBe("cli.command");
    expect(entry?.id).toBeDefined();
    expect(entry?.at).toBeDefined();
    expect(entry?.payload).toEqual({ command: "status", flags: {} });
  });
});
