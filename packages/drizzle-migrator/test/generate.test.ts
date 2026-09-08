import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/core/config.js";
import { canonicalExportName, generateMigrationEntry } from "../src/core/generate.js";
import { defineMigration } from "../src/core/index.js";
import { createFakeLogger } from "./fake-adapter.js";

type GenEnv = {
  sqlDir: string;
  migrationsDir: string;
  config: ReturnType<typeof defineConfig>;
  logger: ReturnType<typeof createFakeLogger>;
};

async function setupGenEnv(): Promise<GenEnv> {
  const tmp = await mkdtemp(join(tmpdir(), "drizzle-migrator-gen-"));
  const sqlDir = join(tmp, "sql");
  const migrationsDir = join(tmp, "versions");
  await mkdir(sqlDir);
  await mkdir(migrationsDir);
  const logger = createFakeLogger();
  const config = defineConfig({ sqlDir, migrationsDir, lockName: "gen:test:lock", logger });
  return { sqlDir, migrationsDir, config, logger };
}

function promptsThatThrow() {
  return {
    askVersion: async () => {
      throw new Error("version prompt should not have been called");
    },
    askName: async () => {
      throw new Error("name prompt should not have been called");
    },
  };
}

function defaultAcceptingPrompts() {
  const asked: string[] = [];
  return {
    asked,
    prompts: {
      askVersion: async (defaultValue: string) => {
        asked.push(`version:${defaultValue}`);
        return defaultValue;
      },
      askName: async (defaultValue: string) => {
        asked.push(`name:${defaultValue}`);
        return defaultValue;
      },
    },
  };
}

describe("generateMigrationEntry", () => {
  let env: GenEnv;

  beforeEach(async () => {
    env = await setupGenEnv();
  });

  it("scaffolds the next patch version from unapplied files, ignoring meta/ and claimed files", async () => {
    await writeFile(join(env.sqlDir, "0006_init.sql"), "CREATE TABLE init (id int);", "utf8");
    await writeFile(join(env.sqlDir, "0007_new_tables.sql"), "CREATE TABLE a (id int);", "utf8");
    await writeFile(join(env.sqlDir, "0008_more.sql"), "CREATE TABLE b (id int);", "utf8");
    await writeFile(join(env.sqlDir, "README.txt"), "not sql", "utf8");
    await mkdir(join(env.sqlDir, "meta"));
    await writeFile(join(env.sqlDir, "meta", "_journal.json"), "[]", "utf8");

    const migration0_0_6 = defineMigration({
      version: "0.0.6",
      name: "init",
      sqlFiles: ["0006_init.sql"],
      up: async () => {},
    });

    const interactive = defaultAcceptingPrompts();
    const result = await generateMigrationEntry({
      config: env.config,
      migrations: [migration0_0_6],
      prompts: interactive.prompts,
    });

    expect(interactive.asked).toEqual(["version:0.0.7", "name:pending-migration"]);
    expect(result).toMatchObject({
      version: "0.0.7",
      name: "pending-migration",
      sqlFiles: ["0007_new_tables.sql", "0008_more.sql"],
      registered: false,
    });
    expect(result.entryPath).toBe(join(env.migrationsDir, "v0.0.7", "index.ts"));

    const content = await readFile(result.entryPath, "utf8");
    expect(content).toContain('import { defineMigration } from "@yourorg/drizzle-migrator";');
    expect(content).toContain("export const migration_v0_0_7 = defineMigration({");
    expect(content).toContain('version: "0.0.7",');
    expect(content).toContain('name: "pending-migration",');
    expect(content).toContain('sqlFiles: ["0007_new_tables.sql", "0008_more.sql"],');
    expect(content).toContain('await ctx.runSqlFile("0007_new_tables.sql");');
    expect(content).toContain('await ctx.runSqlFile("0008_more.sql");');
    expect(content).not.toContain("export default");
    expect(content).not.toContain("0006_init.sql");

    expect(env.logger.lines.join("\n")).toContain(
      'import { migration_v0_0_7 } from "./v0.0.7/index.js";',
    );
  });

  it("starts at 0.0.1 for an empty registry and honors --yes without prompting", async () => {
    await writeFile(join(env.sqlDir, "0001_first.sql"), "CREATE TABLE x (id int);", "utf8");

    const result = await generateMigrationEntry({
      config: env.config,
      migrations: [],
      yes: true,
      prompts: promptsThatThrow(),
    });

    expect(result.version).toBe("0.0.1");
    expect(result.name).toBe("pending-migration");
    await expect(readFile(result.entryPath, "utf8")).resolves.toContain(
      "export const migration_v0_0_1 = defineMigration({",
    );
  });

  it("flags skip prompts individually", async () => {
    await writeFile(join(env.sqlDir, "0009_late.sql"), "CREATE TABLE late (id int);", "utf8");

    const interactive = defaultAcceptingPrompts();
    const result = await generateMigrationEntry({
      config: env.config,
      migrations: [],
      version: "0.1.0",
      prompts: interactive.prompts,
    });

    expect(interactive.asked).toEqual(["name:pending-migration"]);
    expect(result.version).toBe("0.1.0");
    expect(result.name).toBe("pending-migration");
  });

  it("uses all flag values when both are given, never prompting", async () => {
    await writeFile(join(env.sqlDir, "0009_late.sql"), "CREATE TABLE late (id int);", "utf8");

    const result = await generateMigrationEntry({
      config: env.config,
      migrations: [],
      version: "0.2.0",
      name: "add-users",
      prompts: promptsThatThrow(),
    });

    expect(result.version).toBe("0.2.0");
    expect(result.name).toBe("add-users");
    await expect(readFile(result.entryPath, "utf8")).resolves.toContain('name: "add-users",');
  });

  it("never overwrites an existing entry", async () => {
    await writeFile(join(env.sqlDir, "0007_x.sql"), "CREATE TABLE x (id int);", "utf8");
    const existingDir = join(env.migrationsDir, "v0.0.7");
    await mkdir(existingDir);
    await writeFile(join(existingDir, "index.ts"), "export const SENTINEL = true;\n", "utf8");

    await expect(
      generateMigrationEntry({
        config: env.config,
        migrations: [],
        version: "0.0.7",
        yes: true,
        prompts: promptsThatThrow(),
      }),
    ).rejects.toThrow(/already exists.*never overwrite/s);

    await expect(readFile(join(existingDir, "index.ts"), "utf8")).resolves.toContain("SENTINEL");
  });

  it("rejects malformed versions and non-kebab-case names", async () => {
    await writeFile(join(env.sqlDir, "0001_x.sql"), "CREATE TABLE x (id int);", "utf8");

    await expect(
      generateMigrationEntry({
        config: env.config,
        migrations: [],
        version: "abc",
        prompts: promptsThatThrow(),
      }),
    ).rejects.toThrow(/version "abc" must match/);

    await expect(
      generateMigrationEntry({
        config: env.config,
        migrations: [],
        version: "0.0.1",
        name: "Bad Name!",
        prompts: promptsThatThrow(),
      }),
    ).rejects.toThrow(/must be kebab-case/);
  });

  it("errors when every SQL file is already claimed", async () => {
    await writeFile(join(env.sqlDir, "0001_x.sql"), "CREATE TABLE x (id int);", "utf8");
    const claiming = defineMigration({
      version: "0.0.1",
      name: "x",
      sqlFiles: ["0001_x.sql"],
      up: async () => {},
    });

    await expect(
      generateMigrationEntry({
        config: env.config,
        migrations: [claiming],
        version: "0.0.2",
        name: "x",
        prompts: promptsThatThrow(),
      }),
    ).rejects.toThrow(/no unapplied SQL files/);
  });

  it("--register appends the canonical import and array entry to a recognizable registry", async () => {
    await writeFile(join(env.sqlDir, "0002_next.sql"), "CREATE TABLE next (id int);", "utf8");
    const registryPath = join(env.migrationsDir, "index.ts");
    await writeFile(
      registryPath,
      `import { migration_v0_0_1 } from "./v0.0.1/index.js";\n\nexport const migrations = [migration_v0_0_1];\n`,
      "utf8",
    );
    const migration0_0_1 = defineMigration({
      version: "0.0.1",
      name: "one",
      sqlFiles: [],
      up: async () => {},
    });

    const result = await generateMigrationEntry({
      config: env.config,
      migrations: [migration0_0_1],
      yes: true,
      register: true,
      prompts: promptsThatThrow(),
    });

    expect(result.version).toBe("0.0.2");
    expect(result.registered).toBe(true);

    const registry = await readFile(registryPath, "utf8");
    const importIndex = registry.indexOf('import { migration_v0_0_2 } from "./v0.0.2/index.js";');
    expect(importIndex).toBeGreaterThan(
      registry.indexOf('import { migration_v0_0_1 } from "./v0.0.1/index.js";'),
    );
    expect(registry).toContain("  migration_v0_0_1,\n  migration_v0_0_2,");
  });

  it("--register prints the snippet when the registry file is missing or unrecognized", async () => {
    await writeFile(join(env.sqlDir, "0001_x.sql"), "CREATE TABLE x (id int);", "utf8");

    const missing = await generateMigrationEntry({
      config: env.config,
      migrations: [],
      yes: true,
      register: true,
      prompts: promptsThatThrow(),
    });
    expect(missing.registered).toBe(false);
    expect(env.logger.lines.join("\n")).toContain(
      'import { migration_v0_0_1 } from "./v0.0.1/index.js";',
    );

    await writeFile(
      join(env.migrationsDir, "index.ts"),
      "export const somethingElse = 1;\n",
      "utf8",
    );
    const unrecognized = await generateMigrationEntry({
      config: env.config,
      migrations: [],
      version: "0.0.2",
      name: "pending-migration",
      register: true,
      prompts: promptsThatThrow(),
    });
    expect(unrecognized.registered).toBe(false);
    expect(env.logger.lines.join("\n")).toContain(
      'import { migration_v0_0_2 } from "./v0.0.2/index.js";',
    );
  });

  it("--register is idempotent when the entry is already registered", async () => {
    await writeFile(join(env.sqlDir, "0002_next.sql"), "CREATE TABLE next (id int);", "utf8");
    const registryPath = join(env.migrationsDir, "index.ts");
    await writeFile(
      registryPath,
      `import { migration_v0_0_1 } from "./v0.0.1/index.js";\nimport { migration_v0_0_2 } from "./v0.0.2/index.js";\n\nexport const migrations = [\n  migration_v0_0_1,\n  migration_v0_0_2,\n];\n`,
      "utf8",
    );
    const migration0_0_1 = defineMigration({
      version: "0.0.1",
      name: "one",
      sqlFiles: [],
      up: async () => {},
    });

    const result = await generateMigrationEntry({
      config: env.config,
      migrations: [migration0_0_1],
      yes: true,
      register: true,
      prompts: promptsThatThrow(),
    });

    expect(result.registered).toBe(true);
    const registry = await readFile(registryPath, "utf8");
    expect(registry.split("migration_v0_0_2").length - 1).toBe(2);
  });

  it("derives the canonical export name mechanically", () => {
    expect(canonicalExportName("0.0.7")).toBe("migration_v0_0_7");
    expect(canonicalExportName("0.10.3")).toBe("migration_v0_10_3");
    expect(canonicalExportName("1.2.44")).toBe("migration_v1_2_44");
  });
});
