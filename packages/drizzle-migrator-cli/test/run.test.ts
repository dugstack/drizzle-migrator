import { join } from "node:path";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGlobalArgv, runCli } from "../src/index.js";
import {
  configModule,
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
    expect(infoOutput()).toMatch(/^Usage: migrator \[--config=<path>\] <command> \[flags\]/);

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

  it("forwards a command to the core dispatcher (validate, no DB needed)", async () => {
    const root = await newFixture("run-validate");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle/0001_a.sql": "CREATE TABLE a (id int);",
      "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.1", "a", ["0001_a.sql"]),
    });
    process.chdir(root);

    await runCli(["validate"]);
    expect(process.exitCode).toBe(0);
    expect(infoOutput()).toMatch(/registry ok: 1 migration\(s\)/);
  });

  it("strips --config before forwarding and honors a custom config path", async () => {
    const root = await newFixture("run-config-flag");
    await writeFileTree(root, {
      "db/migrator.config.ts": configModule(),
      "drizzle/0001_a.sql": "CREATE TABLE a (id int);",
      "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.1", "a", ["0001_a.sql"]),
    });
    process.chdir(root);

    await runCli(["--config", "db/migrator.config.ts", "validate"]);
    expect(process.exitCode).toBe(0);
    expect(infoOutput()).toMatch(/registry ok: 1 migration\(s\)/);
  });

  it("forwards unknown command flags so the core dispatcher rejects them", async () => {
    const root = await newFixture("run-bad-flag");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle/0001_a.sql": "CREATE TABLE a (id int);",
      "src/db/migrator/v0.0.1/index.ts": migrationEntry("0.0.1", "a", ["0001_a.sql"]),
    });
    process.chdir(root);

    await runCli(["validate", "--bogus"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/unknown flag "--bogus" for command "validate"/);
  });

  it("forwards unknown commands so the core dispatcher rejects them", async () => {
    const root = await newFixture("run-bad-command");
    await writeFileTree(root, { "drizzle-migrator.config.ts": configModule() });
    process.chdir(root);

    await runCli(["teleport"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/unknown command "teleport"/);
  });

  it("surfaces config validation errors with exit code 1", async () => {
    const root = await newFixture("run-bad-config");
    await writeFileTree(root, {
      "drizzle-migrator.config.ts": `export default { dialect: "postgres", postgres: {}, migratorOutDir: "./m" };\n`,
    });
    process.chdir(root);

    await runCli(["validate"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/"postgres.connectionString" is required/);
  });

  it("rejects an explicit config that does not exist", async () => {
    process.chdir(await newFixture("run-missing-explicit"));
    await runCli(["--config", join(packageRoot, "definitely-missing.config.ts"), "validate"]);
    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toMatch(/migrator config not found:/);
  });
});
