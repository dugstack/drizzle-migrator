import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI_COMMANDS, createMigrationCli, parseArgv, redactFlags } from "../src/core/cli.js";
import { type MigratorConfigInput, type MigratorLogger, defineConfig } from "../src/core/config.js";
import { type Migration, defineMigration } from "../src/core/index.js";
import {
  type FakeDatabase,
  createFakeAdapter,
  createFakeDatabase,
  createFakeLogger,
} from "./fake-adapter.js";

const TWO_STATEMENTS =
  "CREATE TABLE a (x int);\n--> statement-breakpoint\nCREATE TABLE b (y int);\n";

type CliEnv = {
  db: FakeDatabase;
  closed: boolean;
  connectCalls: number;
  sqlDir: string;
  logger: ReturnType<typeof createFakeLogger>;
  config: ReturnType<typeof defineConfig>;
  connect: () => Promise<{ db: FakeDatabase; close: () => Promise<void> }>;
};

type CliEnvOptions = {
  versions?: string[];
  sqlFiles?: Record<string, string>;
  db?: Partial<FakeDatabase>;
};

async function setupCliEnv(options: CliEnvOptions = {}): Promise<CliEnv> {
  const tmp = await mkdtemp(join(tmpdir(), "drizzle-migrator-cli-"));
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

  const db = createFakeDatabase(options.db);
  const logger = createFakeLogger();
  const env: CliEnv = {
    db,
    closed: false,
    connectCalls: 0,
    sqlDir,
    logger,
    config: defineConfig({ sqlDir, migrationsDir, lockName: "cli:test:lock", logger }),
    connect: async () => {
      env.connectCalls += 1;
      return {
        db,
        close: async () => {
          env.closed = true;
        },
      };
    },
  };
  return env;
}

function migrationsFor() {
  return [
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
}

async function runCli(
  env: CliEnv,
  argv: string[],
  migrations: readonly Migration[] = migrationsFor(),
) {
  await createMigrationCli({
    adapter: createFakeAdapter(env.db),
    config: env.config,
    migrations,
    connect: env.connect,
    argv,
  });
}

afterEach(() => {
  process.exitCode = 0;
});

describe("parseArgv", () => {
  it("parses commands, boolean flags, and value flags", () => {
    expect(parseArgv(["migrate", "--dry-run"])).toEqual({
      command: "migrate",
      flags: { "dry-run": true },
    });
    expect(parseArgv(["adopt", "--from=0.0.2", "--to=0.0.4", "--force"])).toEqual({
      command: "adopt",
      flags: { from: "0.0.2", to: "0.0.4", force: true },
    });
  });

  it("supports the -y alias for --yes", () => {
    expect(parseArgv(["generate", "-y"])).toEqual({ command: "generate", flags: { yes: true } });
  });

  it("rejects positional arguments and malformed flags", () => {
    expect(() => parseArgv(["migrate", "extra"])).toThrow(/unexpected argument/);
    expect(() => parseArgv(["migrate", "--=x"])).toThrow(/empty flag key/);
    expect(() => parseArgv(["migrate", "--from="])).toThrow(/empty value/);
  });
});

describe("redactFlags", () => {
  it("redacts secret-looking flag values", () => {
    expect(redactFlags({ token: "hunter2", "confirm-database": "db1", force: true })).toEqual({
      token: "[redacted]",
      "confirm-database": "db1",
      force: true,
    });
  });
});

describe("createMigrationCli", () => {
  let env: CliEnv;

  beforeEach(async () => {
    process.exitCode = 0;
    env = await setupCliEnv({
      sqlFiles: { "0001_a.sql": TWO_STATEMENTS, "0002_b.sql": "CREATE TABLE c (z int);" },
      versions: ["0.0.1", "0.0.2"],
    });
  });

  it("migrate applies pending migrations, audits the command, and closes the connection", async () => {
    await runCli(env, ["migrate"]);

    expect(process.exitCode).toBe(0);
    expect(env.db.versions.map((row) => row.version)).toEqual(["0.0.1", "0.0.2"]);
    expect(env.db.logs.some((entry) => entry.kind === "cli.command")).toBe(true);
    expect(env.closed).toBe(true);
    expect(env.logger.lines.join("\n")).toContain("applied 2: 0.0.1, 0.0.2");
  });

  it("migrate --dry-run suppresses the cli.command audit and records nothing", async () => {
    await runCli(env, ["migrate", "--dry-run"]);

    expect(process.exitCode).toBe(0);
    expect(env.db.versions).toHaveLength(0);
    expect(env.db.logs.map((entry) => entry.kind)).toEqual(["dryrun.completed"]);
    expect(env.logger.lines.join("\n")).toContain("dry run: 2 pending migration(s) would run");
  });

  it("reports no pending migrations when everything is applied", async () => {
    await runCli(env, ["migrate"]);
    await runCli(env, ["migrate"]);

    expect(process.exitCode).toBe(0);
    expect(env.logger.lines.at(-1)).toContain("no pending migrations (2 already applied)");
  });

  it("prints status human-readable and audits the command", async () => {
    await runCli(env, ["migrate"]);
    await runCli(env, ["status"]);

    const output = env.logger.lines.join("\n");
    expect(output).toContain("current version: 0.0.2");
    expect(output).toContain('- 0.0.1 "first" (executed at ');
    expect(output).toContain("pending: none");
    expect(output).toContain("recent logs:");
    expect(env.closed).toBe(true);
  });

  it("prints status --json as parseable JSON", async () => {
    await runCli(env, ["migrate"]);
    await runCli(env, ["status", "--json"]);

    const jsonLine = env.logger.lines.filter((line) => line.startsWith("{")).at(-1);
    expect(jsonLine).toBeDefined();
    const report = JSON.parse(jsonLine ?? "{}") as { currentVersion: string | null };
    expect(report.currentVersion).toBe("0.0.2");
  });

  it("validate lints the registry without ever opening a connection", async () => {
    await runCli(env, ["validate"]);

    expect(process.exitCode).toBe(0);
    expect(env.connectCalls).toBe(0);
    expect(env.closed).toBe(false);
    expect(env.db.logs).toHaveLength(0);
    expect(env.logger.lines.at(-1)).toContain("registry ok: 2 migration(s)");
  });

  it("validate exits 1 with the reasons on a broken registry", async () => {
    const broken = [
      defineMigration({ version: "0.0.1", name: "one", up: async () => {} }),
      defineMigration({ version: "0.0.1", name: "another", up: async () => {} }),
    ];
    await runCli(env, ["validate"], broken);

    expect(process.exitCode).toBe(1);
    expect(env.logger.lines.join("\n")).toContain("duplicate version 0.0.1");
    expect(env.connectCalls).toBe(0);
  });

  it("adopt requires --confirm-database and refuses to run without it", async () => {
    await runCli(env, ["adopt", "--to=0.0.2"]);

    expect(process.exitCode).toBe(1);
    expect(env.db.versions).toHaveLength(0);
    expect(env.logger.lines.join("\n")).toContain("--confirm-database");
  });

  it("adopt runs with --confirm-database and closes the connection", async () => {
    await runCli(env, ["adopt", "--to=0.0.2", "--confirm-database=fake_db"]);

    expect(process.exitCode).toBe(0);
    expect(env.db.versions.map((row) => [row.version, row.origin])).toEqual([
      ["0.0.1", "adopted"],
      ["0.0.2", "adopted"],
    ]);
    expect(env.closed).toBe(true);
  });

  it("generate is dispatched but not implemented until Milestone 5", async () => {
    await runCli(env, ["generate", "--yes"]);

    expect(process.exitCode).toBe(1);
    expect(env.logger.lines.join("\n")).toContain("TODO: implement in Milestone 5");
  });

  it("unknown commands exit 1 with usage", async () => {
    await runCli(env, ["frobnicate"]);

    expect(process.exitCode).toBe(1);
    expect(env.logger.lines.join("\n")).toContain('unknown command "frobnicate"');
    expect(env.logger.lines.join("\n")).toContain("Usage:");
  });

  it("no command prints usage and exits 0", async () => {
    await runCli(env, []);

    expect(process.exitCode).toBe(0);
    expect(env.logger.lines.join("\n")).toContain("Usage:");
    expect(env.connectCalls).toBe(0);
  });

  it("rejects unknown flags, mistyped flags, and exits 1", async () => {
    await runCli(env, ["migrate", "--bogus"]);
    expect(process.exitCode).toBe(1);
    expect(env.logger.lines.join("\n")).toContain('unknown flag "--bogus"');

    await runCli(env, ["migrate", "--dry-run=yes"]);
    expect(process.exitCode).toBe(1);
    expect(env.logger.lines.join("\n")).toContain('flag "--dry-run" takes no value');

    await runCli(env, ["adopt", "--from"]);
    expect(process.exitCode).toBe(1);
    expect(env.logger.lines.join("\n")).toContain('flag "--from" requires a value');

    await runCli(env, ["adopt", "--from=0.0.1", "--confirm-database=other_db"]);
    expect(process.exitCode).toBe(1);
    expect(env.db.versions).toHaveLength(0);
  });

  it("exit code is 1 with the error detail when the engine throws mid-run", async () => {
    await writeFile(join(env.sqlDir, "0002_b.sql"), "SELECT FAIL_MARKER;", "utf8");
    env.db.failingStatement = "FAIL_MARKER";
    await runCli(env, ["migrate"]);

    expect(process.exitCode).toBe(1);
    expect(env.logger.lines.join("\n")).toContain("fake executeRaw failed");
    expect(env.closed).toBe(true);
  });
});

describe("defineConfig validation", () => {
  it("resolves documented defaults", () => {
    const config = defineConfig({ lockName: "app:db:migrations" });
    expect(config).toMatchObject({
      sqlDir: "./drizzle",
      migrationsDir: "./migrations",
      schema: "migrations",
      tables: { versions: "migration_versions", logs: "migration_logs" },
      lock: { waitTimeoutMs: 600_000, retryIntervalMs: 5_000 },
    });
    expect(typeof config.logger.info).toBe("function");
  });

  it("requires lockName and names the offending field", () => {
    expect(() => defineConfig({ lockName: "" })).toThrow(/"lockName" is required/);
    expect(() => defineConfig({ sqlDir: "./drizzle" } as MigratorConfigInput)).toThrow(
      /"lockName" is required/,
    );
  });

  it("rejects non-identifier schema and table names, naming the field", () => {
    expect(() => defineConfig({ lockName: "x", schema: "Migrations" })).toThrow(
      /"schema" must be an identifier/,
    );
    expect(() =>
      defineConfig({ lockName: "x", tables: { versions: "versions-1", logs: "logs" } }),
    ).toThrow(/"tables\.versions" must be an identifier/);
    expect(() => defineConfig({ lockName: "x", tables: { versions: "v", logs: "l;og" } })).toThrow(
      /"tables\.logs" must be an identifier/,
    );
  });

  it("rejects URL-shaped paths and null bytes", () => {
    expect(() => defineConfig({ lockName: "x", sqlDir: "https://example.com/drizzle" })).toThrow(
      /"sqlDir" must be an absolute filesystem path/,
    );
    expect(() => defineConfig({ lockName: "x", migrationsDir: "./a\0b" })).toThrow(
      /"migrationsDir" must not contain null bytes/,
    );
  });

  it("rejects a logger without info/error and invalid lock timings", () => {
    expect(() =>
      defineConfig({ lockName: "x", logger: { info: "nope" } as unknown as MigratorLogger }),
    ).toThrow(/"logger" must be an object with info/);
    expect(() => defineConfig({ lockName: "x", lock: { waitTimeoutMs: -1 } })).toThrow(
      /"lock\.waitTimeoutMs" must be a positive integer/,
    );
    expect(() => defineConfig({ lockName: "x", lock: { retryIntervalMs: 1.5 } })).toThrow(
      /"lock\.retryIntervalMs" must be a non-negative integer/,
    );
  });

  it("aggregates multiple violations into one error", () => {
    expect(() => defineConfig({ lockName: "", schema: "Bad Schema", sqlDir: "http://x" })).toThrow(
      /invalid migrator config:\n- "lockName".*- "sqlDir".*- "schema"/s,
    );
  });
});

describe("CLI command table", () => {
  it("matches the §7 dispatch table", () => {
    expect(CLI_COMMANDS.map((spec) => spec.name)).toEqual([
      "migrate",
      "adopt",
      "status",
      "generate",
      "validate",
    ]);
    expect(
      CLI_COMMANDS.find((spec) => spec.name === "adopt")?.flags.map((flag) => flag.name),
    ).toEqual(["from", "to", "force", "confirm-database"]);
    expect(
      CLI_COMMANDS.find((spec) => spec.name === "generate")?.flags.map((flag) => flag.name),
    ).toEqual(["version", "name", "yes", "register"]);
  });
});
