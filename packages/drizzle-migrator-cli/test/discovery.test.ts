import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, discoverMigrations, findMigratorConfigPath } from "../src/index.js";
import { createModuleLoader } from "../src/loader.js";
import {
  configModule,
  createFakeLogger,
  makeFixtureProject,
  migrationEntry,
  removeFixture,
  writeFileTree,
} from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => removeFixture(root)));
});

async function newProject(prefix: string): Promise<string> {
  const root = await makeFixtureProject(prefix);
  cleanup.push(root);
  return root;
}

describe("migration folder discovery", () => {
  it("loads every v<semver>/index.ts and sorts numerically by semver", async () => {
    const root = await newProject("discover-sorted");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle/0001_a.sql": "CREATE TABLE a (id int);",
      "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.1", "first"),
      "src/db/migrator/v0.10.0/index.ts": migrationEntry("0.10.0", "ten"),
      "src/db/migrator/v0.9.0/index.ts": migrationEntry("0.9.0", "nine"),
    });
    const logger = createFakeLogger();
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    const migrations = await discoverMigrations({
      migrationsDir: join(root, "src/db/migrator"),
      loader,
      logger,
    });
    expect(migrations.map((migration) => migration.version)).toEqual(["0.0.1", "0.9.0", "0.10.0"]);
    expect(migrations.map((migration) => migration.name)).toEqual(["first", "nine", "ten"]);
    expect(logger.errors).toEqual([]);
  });

  it("tolerates helper exports beside the single migration export", async () => {
    const root = await newProject("discover-helper-export");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "src/db/migrator/v1.2.3/index.ts": `${migrationEntry("1.2.3", "with-helper")}\nexport const helper = 42;\n`,
    });
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    const migrations = await discoverMigrations({
      migrationsDir: join(root, "src/db/migrator"),
      loader,
      logger: createFakeLogger(),
    });
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.version).toBe("1.2.3");
  });

  it("rejects a folder whose name is not v<semver>", async () => {
    const root = await newProject("discover-bad-folder");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "src/db/migrator/v0.1/index.ts": migrationEntry("0.1", "bad"),
    });
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    await expect(
      discoverMigrations({
        migrationsDir: join(root, "src/db/migrator"),
        loader,
        logger: createFakeLogger(),
      }),
    ).rejects.toThrow(/invalid migration folder "v0\.1".*v<semver>/s);
  });

  it("rejects a version folder without index.ts", async () => {
    const root = await newProject("discover-no-index");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
    });
    await mkdir(join(root, "src/db/migrator/v0.0.1"), { recursive: true });
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    await expect(
      discoverMigrations({
        migrationsDir: join(root, "src/db/migrator"),
        loader,
        logger: createFakeLogger(),
      }),
    ).rejects.toThrow(/migration folder "v0\.0\.1" has no index\.ts/);
  });

  it("rejects folder/version drift", async () => {
    const root = await newProject("discover-drift");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.2", "drifted"),
    });
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    await expect(
      discoverMigrations({
        migrationsDir: join(root, "src/db/migrator"),
        loader,
        logger: createFakeLogger(),
      }),
    ).rejects.toThrow(
      /migration "v0\.0\.1" declares version "0\.0\.2".*exactly "v" \+ the version field/s,
    );
  });

  it("rejects an entry exporting multiple migrations", async () => {
    const root = await newProject("discover-two-exports");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "src/db/migrator/v0.0.1/index.ts": `${migrationEntry("0.0.1", "one")}\nexport const second = { version: "0.0.99", name: "two", up: async () => {} };\n`,
    });
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    await expect(
      discoverMigrations({
        migrationsDir: join(root, "src/db/migrator"),
        loader,
        logger: createFakeLogger(),
      }),
    ).rejects.toThrow(/exports 2 migrations \(migration_v0_0_1, second\)/);
  });

  it("rejects an entry with no migration export", async () => {
    const root = await newProject("discover-no-export");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "src/db/migrator/v0.0.1/index.ts": "export const placeholder = true;\n",
    });
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    await expect(
      discoverMigrations({
        migrationsDir: join(root, "src/db/migrator"),
        loader,
        logger: createFakeLogger(),
      }),
    ).rejects.toThrow(/no migration export found in .*v0\.0\.1.*defineMigration/s);
  });

  it("rejects a flat <version>.ts file in the migrations folder", async () => {
    const root = await newProject("discover-flat-file");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "src/db/migrator/0.0.1.ts": "export const flat = true;\n",
    });
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    await expect(
      discoverMigrations({
        migrationsDir: join(root, "src/db/migrator"),
        loader,
        logger: createFakeLogger(),
      }),
    ).rejects.toThrow(/flat file "0\.0\.1\.ts".*folder-per-version/s);
  });

  it("returns an empty list (with a note) when the folder does not exist yet", async () => {
    const root = await newProject("discover-missing-dir");
    await writeFileTree(root, { "drizzle-migrator.config.ts": configModule() });
    const logger = createFakeLogger();
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    const migrations = await discoverMigrations({
      migrationsDir: join(root, "src/db/migrator"),
      loader,
      logger,
    });
    expect(migrations).toEqual([]);
    expect(logger.lines.join("\n")).toMatch(/does not exist yet/);
  });

  it("ignores a leftover manual registry index.ts with a note", async () => {
    const root = await newProject("discover-legacy-registry");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "src/db/migrator/index.ts": "export const migrations = [];\n",
      "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.1", "first"),
    });
    const logger = createFakeLogger();
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    const migrations = await discoverMigrations({
      migrationsDir: join(root, "src/db/migrator"),
      loader,
      logger,
    });
    expect(migrations.map((migration) => migration.version)).toEqual(["0.0.1"]);
    expect(logger.lines.join("\n")).toMatch(/ignoring .*index\.ts.*auto-discovers/s);
  });
});

describe("migrator config discovery", () => {
  it("finds drizzle-migrator.config.ts in the cwd", async () => {
    const root = await newProject("cfgpath-default");
    await writeFileTree(root, { "drizzle-migrator.config.ts": configModule() });
    expect(await findMigratorConfigPath(root)).toBe(join(root, "drizzle-migrator.config.ts"));
  });

  it("prefers .ts over later extensions", async () => {
    const root = await newProject("cfgpath-precedence");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle-migrator.config.js": configModule(),
    });
    expect(await findMigratorConfigPath(root)).toBe(join(root, "drizzle-migrator.config.ts"));
  });

  it("resolves an explicit --config path, appending the extension when omitted", async () => {
    const root = await newProject("cfgpath-explicit");
    await writeFileTree(root, { "db/migrator.config.ts": configModule() });
    expect(await findMigratorConfigPath(root, "db/migrator.config.ts")).toBe(
      join(root, "db/migrator.config.ts"),
    );
    expect(await findMigratorConfigPath(root, "db/migrator.config")).toBe(
      join(root, "db/migrator.config.ts"),
    );
  });

  it("fails loudly for a missing explicit path", async () => {
    const root = await newProject("cfgpath-missing-explicit");
    await expect(findMigratorConfigPath(root, "nope/missing.ts")).rejects.toThrow(
      /migrator config not found: nope\/missing\.ts/,
    );
  });

  it("fails with guidance when no config exists", async () => {
    const root = await newProject("cfgpath-none");
    await expect(findMigratorConfigPath(root)).rejects.toThrow(
      /no migrator config found in .* — create drizzle-migrator\.config\.ts or pass --config <path>/s,
    );
  });

  it("errors when the discovered config throws on load", async () => {
    const root = await newProject("cfgpath-broken-module");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": "throw new Error('boom in config');\n",
    });
    const loader = createModuleLoader(join(root, "drizzle-migrator.config.ts"));
    await expect(loader(join(root, "drizzle-migrator.config.ts"))).rejects.toThrow(
      /boom in config/,
    );
  });
});

describe("compareVersions", () => {
  it("sorts numerically, not lexically", () => {
    const versions = ["0.0.10", "0.0.2", "0.10.0", "0.9.0", "1.0.0"];
    expect([...versions].sort(compareVersions)).toEqual([
      "0.0.2",
      "0.0.10",
      "0.9.0",
      "0.10.0",
      "1.0.0",
    ]);
  });
});
