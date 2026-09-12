import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMigrator, defineConfig } from "../src/core/index.js";
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
  const config = defineConfig({
    sqlDir,
    migrationsDir,
    lockName: "factory:test:lock",
    logger: createFakeLogger(),
  });
  return { db, config };
}

describe("createMigrator", () => {
  it("exposes every bound operation", async () => {
    const { db, config } = await createFixture();
    const migrator = createMigrator({ dialect: createFakeAdapter(db), config, migrations: [] });

    expect(Object.keys(migrator).sort()).toEqual([
      "adoptMigrations",
      "createCli",
      "generateMigrationEntry",
      "getStatus",
      "runMigrations",
      "validate",
    ]);
    await expect(migrator.validate()).resolves.toEqual({ ok: true, errors: [] });
    await expect(migrator.runMigrations({ db })).resolves.toMatchObject({ applied: [] });
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
    const { db, config } = await createFixture();
    const dialect = createFakeAdapter(db);
    dialect.quoteIdentifier = (identifier) => {
      if (identifier === "BadSchema") {
        throw new Error("dialect rejected identifier");
      }
      return `"${identifier}"`;
    };

    expect(() =>
      createMigrator({ dialect, config: { ...config, schema: "BadSchema" }, migrations: [] }),
    ).toThrow("dialect rejected identifier");
  });
});
