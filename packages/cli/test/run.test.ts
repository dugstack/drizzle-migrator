import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGlobalArgv, runCli } from "../src/index.js";
import {
  configModule,
  configModuleWithoutPostgres,
  makeFixtureProject,
  migrationEntry,
  packageRoot,
  removeFixture,
  writeFileTree,
} from "./helpers.js";

const originalCwd = process.cwd();
const fixtureDirs: string[] = [];
let infoSpy: MockInstance;
let errorSpy: MockInstance;

async function newFixture(prefix: string): Promise<string> {
  const root = await makeFixtureProject(prefix);
  fixtureDirs.push(root);
  return root;
}

beforeEach(() => {
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = 0;
  await Promise.all(fixtureDirs.splice(0).map((root) => removeFixture(root)));
  vi.restoreAllMocks();
});

function infoOutput(): string {
  return infoSpy.mock.calls.flatMap((call) => call.map(String)).join("\n");
}

function errorOutput(): string {
  return errorSpy.mock.calls.flatMap((call) => call.map(String)).join("\n");
}

/** A validate-ready fixture: config + one SQL file + one discovered migration entry. */
async function newValidateFixture(prefix: string, config: string): Promise<string> {
  const root = await newFixture(prefix);
  await writeFileTree(root, {
    "drizzle-migrator.config.ts": config,
    "drizzle/0001_a.sql": "CREATE TABLE a (id int);",
    "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.1", "a", ["0001_a.sql"]),
  });
  return root;
}

describe("parseGlobalArgv", () => {
  it("keeps the command and its flags untouched", () => {
    expect(parseGlobalArgv(["migrate", "--dry-run"])).toEqual({
      config: undefined,
      help: false,
      commandArgv: ["migrate", "--dry-run"],
    });
    expect(parseGlobalArgv(["status", "--json"])).toEqual({
      config: undefined,
      help: false,
      commandArgv: ["status", "--json"],
    });
  });

  it("extracts --config in both spellings", () => {
    expect(parseGlobalArgv(["--config", "./db/migrator.config.ts", "status"])).toEqual({
      config: "./db/migrator.config.ts",
      help: false,
      commandArgv: ["status"],
    });
    expect(parseGlobalArgv(["--config=./x.ts", "generate", "--yes"])).toEqual({
      config: "./x.ts",
      help: false,
      commandArgv: ["generate", "--yes"],
    });
  });

  it("rejects a valueless or empty --config", () => {
    expect(() => parseGlobalArgv(["--config"])).toThrow(/--config requires a file path/);
    expect(() => parseGlobalArgv(["--config="])).toThrow(/--config requires a file path/);
    expect(() => parseGlobalArgv(["--config", "--help"])).toThrow(/--config requires a file path/);
  });

  it("rejects unknown global flags before the command", () => {
    expect(() => parseGlobalArgv(["--bogus", "migrate"])).toThrow(/unknown global flag "--bogus"/);
  });
});

describe("runCli", () => {
  it("prints usage for --help and for an empty invocation without touching the filesystem", async () => {
    process.chdir(await newFixture("run-help")); // no config file here
    await runCli(["--help"]);
    expect(process.exitCode).toBe(0);
    expect(infoOutput()).toMatch(
      /^Usage: drizzle-migrator \[--config=<path>\] <command> \[flags\]/,
    );

    process.exitCode = 0;
    infoSpy.mockClear();
    await runCli([]);
    expect(process.exitCode).toBe(0);
    expect(infoOutput()).toMatch(/migrate --dry-run/);
  });

  it("fails with guidance when no config can be discovered", async () => {
    process.chdir(await newFixture("run-no-config"));
    await runCli(["status"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/no migrator config found in .*--config <path>/s);
  });

  it("rejects unknown commands before touching the filesystem", async () => {
    process.chdir(await newFixture("run-bad-command"));
    await runCli(["teleport"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/unknown command "teleport"/);
    // printUsage logs through logger.info, which console.info carries.
    expect(infoOutput()).toMatch(/Usage:/);
  });

  it("rejects unknown command flags before touching the filesystem", async () => {
    process.chdir(await newFixture("run-bad-flag"));
    await runCli(["validate", "--bogus"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/unknown flag "--bogus" for command "validate"/);
  });

  it("rejects mistyped command flags", async () => {
    process.chdir(await newFixture("run-bad-flag-type"));
    await runCli(["migrate", "--dry-run=yes"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/flag "--dry-run" takes no value/);

    process.exitCode = 0;
    errorSpy.mockClear();
    await runCli(["adopt", "--from"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/flag "--from" requires a value/);
  });

  it("runs validate connection-free when the config has no postgres block", async () => {
    process.chdir(await newValidateFixture("run-validate-no-db", configModuleWithoutPostgres()));
    await runCli(["validate"]);
    expect(process.exitCode).toBe(0);
    expect(infoOutput()).toMatch(/registry ok: 1 migration\(s\)/);
  });

  it("runs validate connection-free when the connection string is empty", async () => {
    process.chdir(await newValidateFixture("run-validate-empty-db", configModule("")));
    await runCli(["validate"]);
    expect(process.exitCode).toBe(0);
    expect(infoOutput()).toMatch(/registry ok: 1 migration\(s\)/);
  });

  it("exits 1 when validate is configured with an unreachable connection", async () => {
    process.chdir(
      await newValidateFixture(
        "run-validate-unreachable",
        configModule("postgres://127.0.0.1:1/app"),
      ),
    );
    await runCli(["validate"]);
    expect(process.exitCode).toBe(1);
    // Sandboxes can deny loopback sockets with EPERM before a TCP refusal occurs.
    expect(errorOutput()).toMatch(/ECONNREFUSED|EPERM|error|timeout/s);
  });

  it("exits 1 with the reasons when validate finds a broken registry", async () => {
    const root = await newFixture("run-validate-broken");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModuleWithoutPostgres(),
      "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.1", "a", ["missing.sql"]),
    });
    process.chdir(root);

    await runCli(["validate"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/not found under/);
  });

  it("fails database commands before any connection attempt when postgres is absent", async () => {
    process.chdir(await newValidateFixture("run-status-no-db", configModuleWithoutPostgres()));
    await runCli(["status"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(
      /command "status" requires a database connection — set "postgres.connectionString"/,
    );
    // No connection error noise: the requirement check precedes any attempt.
    expect(errorOutput()).not.toMatch(/ECONNREFUSED/);

    process.exitCode = 0;
    errorSpy.mockClear();
    await runCli(["migrate"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/command "migrate" requires a database connection/);
  });

  it("generate --yes uses the core suggestion defaults without prompts or a database", async () => {
    const root = await newFixture("run-generate");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModuleWithoutPostgres(),
      "drizzle/0001_a.sql": "CREATE TABLE a (id int);",
    });
    process.chdir(root);

    await runCli(["generate", "--yes"]);
    expect(process.exitCode).toBe(0);
    expect(infoOutput()).toMatch(
      /created .*v0\.0\.1.index\.ts \(version 0\.0\.1, name "pending-migration"\)/,
    );
    const generated = await readFile(join(root, "src/db/migrator/v0.0.1/index.ts"), "utf8");
    expect(generated).toMatch(/export const migration_v0_0_1 = defineMigration\(/);
    expect(generated).toContain('"0001_a.sql"');
  });

  it("generate with explicit flags skips both prompts", async () => {
    const root = await newFixture("run-generate-flags");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModuleWithoutPostgres(),
      "drizzle/0001_a.sql": "CREATE TABLE a (id int);",
    });
    process.chdir(root);

    await runCli(["generate", "--version=0.3.0", "--name=add-users"]);
    expect(process.exitCode).toBe(0);
    const generated = await readFile(join(root, "src/db/migrator/v0.3.0/index.ts"), "utf8");
    expect(generated).toContain('version: "0.3.0",');
    expect(generated).toContain('name: "add-users",');
  });

  it("strips --config before dispatch and honors a custom config path", async () => {
    const root = await newFixture("run-config-flag");
    await writeFileTree(root, {
      "db/migrator.config.ts": configModuleWithoutPostgres(),
      "drizzle/0001_a.sql": "CREATE TABLE a (id int);",
      "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.1", "a", ["0001_a.sql"]),
    });
    process.chdir(root);

    await runCli(["--config", "db/migrator.config.ts", "validate"]);
    expect(process.exitCode).toBe(0);
    expect(infoOutput()).toMatch(/registry ok: 1 migration\(s\)/);
  });

  it("surfaces config validation errors with exit code 1", async () => {
    const root = await newFixture("run-bad-config");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": `export default { dialect: "postgres", postgres: { connectionString: "mysql://x/y" }, migratorOutDir: "./m" };\n`,
    });
    process.chdir(root);

    await runCli(["validate"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/scheme "mysql" is not postgres/);
  });

  it("rejects an explicit config that does not exist", async () => {
    process.chdir(await newFixture("run-missing-explicit"));
    await runCli(["--config", join(packageRoot, "definitely-missing.config.ts"), "validate"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/migrator config not found:/);
  });
});
