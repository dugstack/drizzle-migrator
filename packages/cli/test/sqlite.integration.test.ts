import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  type MockInstance,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runCli } from "../src/index.js";
import { fixtureRoot, migrationEntry } from "./helpers.js";

const TIMEOUT = 60_000;

const originalCwd = process.cwd();
let infoSpy: MockInstance;
let errorSpy: MockInstance;
let project: string;
let dbPath: string;

async function writeSqliteProject(root: string): Promise<void> {
  await mkdir(join(root, "drizzle"), { recursive: true });
  await mkdir(join(root, "src/db/migrator/v0.0.1"), { recursive: true });
  await writeFile(
    join(root, "drizzle-migrator.config.ts"),
    `export default {
  dialect: "sqlite",
  sqlite: { path: process.env.SQLITE_PATH },
  migratorOutDir: "./src/db/migrator",
};
`,
    "utf8",
  );
  await writeFile(
    join(root, "drizzle/0001_users.sql"),
    "CREATE TABLE users (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO users (id) VALUES (1);",
    "utf8",
  );
  await writeFile(
    join(root, "src/db/migrator/v0.0.1/index.ts"),
    migrationEntry("0.0.1", "users", ["0001_users.sql"]),
    "utf8",
  );
}

describe("cli end-to-end (sqlite)", () => {
  beforeAll(async () => {
    // A realistic consumer project: the sqlite block points at a database file
    // inside the project, read through an environment variable like the pg
    // e2e's DATABASE_URL pattern.
    project = await mkdtemp(join(fixtureRoot, "e2e-sqlite-"));
    dbPath = join(project, "data", "app.db");
    // better-sqlite3 does not create parent directories; real projects do.
    await mkdir(join(project, "data"), { recursive: true });
    await writeSqliteProject(project);
  }, TIMEOUT);

  afterAll(async () => {
    process.chdir(originalCwd);
    Reflect.deleteProperty(process.env, "SQLITE_PATH");
    if (project !== undefined) {
      await rm(project, { recursive: true, force: true }).catch(() => {});
    }
  }, TIMEOUT);

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  function infoOutput(): string {
    return infoSpy.mock.calls.flatMap((call) => call.map(String)).join("\n");
  }

  function errorOutput(): string {
    return errorSpy.mock.calls.flatMap((call) => call.map(String)).join("\n");
  }

  function jsonReport(): { currentVersion: string | null } | undefined {
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed: unknown = JSON.parse(String(call[0]));
        if (typeof parsed === "object" && parsed !== null && "currentVersion" in parsed) {
          return parsed as { currentVersion: string | null };
        }
      } catch {
        // Not the JSON status line; keep scanning.
      }
    }
    return undefined;
  }

  it(
    "runs the full path: migrate, verify rows, no-op migrate, status",
    async () => {
      process.chdir(project);
      process.env.SQLITE_PATH = dbPath;

      await runCli(["migrate"]);
      expect(process.exitCode).toBe(0);
      expect(infoOutput()).toMatch(/applied 1: 0\.0\.1/);

      const db = new Database(dbPath);
      try {
        const users = db.prepare("SELECT count(*) AS count FROM users").get() as { count: number };
        expect(users.count).toBe(1);
        const versions = db
          .prepare("SELECT version, origin FROM migration_versions ORDER BY version")
          .all() as Array<{ version: string; origin: string }>;
        expect(versions).toEqual([{ version: "0.0.1", origin: "executed" }]);
      } finally {
        db.close();
      }

      process.exitCode = 0;
      infoSpy.mockClear();
      await runCli(["migrate"]);
      expect(process.exitCode).toBe(0);
      expect(infoOutput()).toMatch(/no pending migrations/);

      process.exitCode = 0;
      infoSpy.mockClear();
      await runCli(["status", "--json"]);
      expect(process.exitCode).toBe(0);
      expect(jsonReport()?.currentVersion).toBe("0.0.1");
    },
    TIMEOUT,
  );

  it(
    "validate with the configured connection records the audit trail",
    async () => {
      process.chdir(project);
      process.env.SQLITE_PATH = dbPath;

      process.exitCode = 0;
      infoSpy.mockClear();
      await runCli(["validate"]);
      expect(process.exitCode).toBe(0);
      expect(infoOutput()).toMatch(/registry ok: 1 migration\(s\)/);

      const db = new Database(dbPath);
      try {
        const logs = db
          .prepare(
            "SELECT kind, payload FROM migration_logs WHERE kind LIKE 'validation.%' ORDER BY at",
          )
          .all() as Array<{ kind: string; payload: string }>;
        expect(logs.map((row) => row.kind)).toEqual(["validation.started", "validation.completed"]);
        expect(JSON.parse(logs[1]?.payload ?? "{}")).toMatchObject({ status: "passed" });
      } finally {
        db.close();
      }
    },
    TIMEOUT,
  );

  it(
    "a project without a sqlite path validates but refuses database commands",
    async () => {
      const noDbProject = await mkdtemp(join(fixtureRoot, "e2e-sqlite-nodb-"));
      try {
        await writeSqliteProject(noDbProject);

        process.chdir(noDbProject);
        Reflect.deleteProperty(process.env, "SQLITE_PATH");

        await runCli(["validate"]);
        expect(process.exitCode).toBe(0);
        expect(infoOutput()).toMatch(/registry ok: 1 migration\(s\)/);

        process.exitCode = 0;
        errorSpy.mockClear();
        await runCli(["migrate"]);
        expect(process.exitCode).toBe(1);
        expect(errorOutput()).toMatch(/command "migrate" requires a database connection/);
        expect(errorOutput()).toMatch(/"sqlite\.path"/);
      } finally {
        process.chdir(originalCwd);
        await rm(noDbProject, { recursive: true, force: true }).catch(() => {});
      }
    },
    TIMEOUT,
  );
});
