import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { MySqlContainer, type StartedMySqlContainer } from "@testcontainers/mysql";
import { type Connection, type RowDataPacket, createConnection } from "mysql2/promise";
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

const TIMEOUT = 120_000;
const STARTUP_TIMEOUT = 300_000;
const MYSQL_IMAGE = "mysql:8.0";

async function resolveDockerHost(): Promise<string | null> {
  const host = process.env.DOCKER_HOST;
  if (host && !host.startsWith("unix://")) {
    return host;
  }
  const sockets = [
    host?.slice("unix://".length),
    "/var/run/docker.sock",
    process.env.HOME ? `${process.env.HOME}/.docker/desktop/docker.sock` : undefined,
  ].filter((socketPath): socketPath is string => socketPath !== undefined);
  for (const socketPath of sockets) {
    try {
      await access(socketPath);
      const reachable = await new Promise<boolean>((resolve) => {
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
      if (reachable) {
        return `unix://${socketPath}`;
      }
    } catch {
      // Try the next standard Docker socket location.
    }
  }
  return null;
}

const dockerHost = await resolveDockerHost();
if (dockerHost) {
  process.env.DOCKER_HOST = dockerHost;
}
const dockerAvailable = dockerHost !== null;
if (!dockerAvailable) {
  console.warn(
    "[cli.mysql.integration] Docker is not reachable — skipping testcontainers end-to-end tests (CI runs them with Docker).",
  );
}

const suite = describe.skipIf(!dockerAvailable);

const originalCwd = process.cwd();
let infoSpy: MockInstance;
let errorSpy: MockInstance;

// The image's non-root user only owns its default database; the fixture
// project targets a throwaway database, so the admin connection runs as root.
suite("cli end-to-end (testcontainers, mysql)", () => {
  let container: StartedMySqlContainer;
  let adminConnection: Connection;
  let project: string;
  let fixtureDatabaseUri: string;

  beforeAll(async () => {
    container = await new MySqlContainer(MYSQL_IMAGE).start();
    adminConnection = await createConnection(container.getConnectionUri(true));
    await adminConnection.query("CREATE DATABASE e2ecli");
    // Every admin-side assertion below targets the fixture database.
    await adminConnection.query("USE `e2ecli`");
    const uri = new URL(container.getConnectionUri(true));
    uri.pathname = "/e2ecli";
    fixtureDatabaseUri = uri.toString();

    // A realistic consumer project: no drizzleOutDir, no drizzle.config — the
    // SQL directory falls back to ./drizzle; the config reads DATABASE_URL
    // from the environment like the pg e2e does.
    project = await mkdtemp(join(fixtureRoot, "e2e-mysql-"));
    await mkdir(join(project, "drizzle"), { recursive: true });
    await mkdir(join(project, "src/db/migrator/v0.0.1"), { recursive: true });
    await writeFile(
      join(project, "drizzle-migrator.config.ts"),
      `export default {
  dialect: "mysql",
  mysql: { connectionString: process.env.DATABASE_URL },
  migratorOutDir: "./src/db/migrator",
};
`,
      "utf8",
    );
    await writeFile(
      join(project, "drizzle/0001_users.sql"),
      "CREATE TABLE users (id INT PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO users (id) VALUES (1);",
      "utf8",
    );
    await writeFile(
      join(project, "src/db/migrator/v0.0.1/index.ts"),
      migrationEntry("0.0.1", "users", ["0001_users.sql"]),
      "utf8",
    );
  }, STARTUP_TIMEOUT);

  afterAll(async () => {
    process.chdir(originalCwd);
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    await adminConnection.end().catch(() => {});
    await container.stop().catch(() => {});
    if (project !== undefined) {
      await rm(project, { recursive: true, force: true }).catch(() => {});
    }
  }, STARTUP_TIMEOUT);

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
    "runs the full path: discover config + migrations, migrate, status, generate, migrate",
    async () => {
      process.chdir(project);
      process.env.DATABASE_URL = fixtureDatabaseUri;

      await runCli(["migrate"]);
      expect(process.exitCode).toBe(0);
      expect(infoOutput()).toMatch(/applied 1: 0\.0\.1/);

      const users = await adminConnection.query<RowDataPacket[]>(
        "SELECT count(*) AS count FROM users",
      );
      expect((users[0][0] as { count: number } | undefined)?.count).toBe(1);
      const versions = await adminConnection.query<RowDataPacket[]>(
        "SELECT version, origin FROM migration_versions ORDER BY version",
      );
      expect(versions[0]).toEqual([{ version: "0.0.1", origin: "executed" }]);

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

      // generate: a new drizzle-kit output appears; the CLI scaffolds v0.0.2 from it
      await writeFile(
        join(project, "drizzle/0002_posts.sql"),
        "CREATE TABLE posts (id int);",
        "utf8",
      );
      process.exitCode = 0;
      infoSpy.mockClear();
      await runCli(["generate", "--yes"]);
      expect(process.exitCode).toBe(0);
      const generated = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(project, "src/db/migrator/v0.0.2/index.ts"), "utf8"),
      );
      expect(generated).toMatch(/export const migration_v0_0_2 = defineMigration\(/);
      expect(generated).toContain('"0002_posts.sql"');

      process.exitCode = 0;
      infoSpy.mockClear();
      await runCli(["migrate"]);
      expect(process.exitCode).toBe(0);
      expect(infoOutput()).toMatch(/applied 1: 0\.0\.2/);
      await adminConnection.query("SELECT 1 FROM posts");
      const finalVersions = await adminConnection.query<RowDataPacket[]>(
        "SELECT version, origin FROM migration_versions ORDER BY version",
      );
      expect(finalVersions[0]).toEqual([
        { version: "0.0.1", origin: "executed" },
        { version: "0.0.2", origin: "executed" },
      ]);
    },
    TIMEOUT,
  );

  it(
    "fails with exit code 1 when the database is unreachable",
    async () => {
      process.chdir(project);
      process.env.DATABASE_URL = "mysql://127.0.0.1:1/e2ecli";

      await runCli(["status"]);
      expect(process.exitCode).toBe(1);
      expect(errorOutput()).toMatch(/ECONNREFUSED|error|timeout/s);
    },
    TIMEOUT,
  );

  it(
    "validate with MySQL configuration records started plus terminal audit events",
    async () => {
      process.chdir(project);
      process.env.DATABASE_URL = fixtureDatabaseUri;

      process.exitCode = 0;
      infoSpy.mockClear();
      await runCli(["validate"]);
      expect(process.exitCode).toBe(0);
      expect(infoOutput()).toMatch(/registry ok: 2 migration\(s\)/);

      const logs = await adminConnection.query<RowDataPacket[]>(
        "SELECT kind, payload FROM migration_logs WHERE kind LIKE 'validation.%' ORDER BY at",
      );
      expect(logs[0].map((row) => row.kind)).toEqual([
        "validation.started",
        "validation.completed",
      ]);
      // mysql2 parses JSON columns into objects already.
      const payload: unknown = logs[0][1]?.payload;
      expect(typeof payload === "string" ? JSON.parse(payload) : payload).toMatchObject({
        status: "passed",
      });
    },
    TIMEOUT,
  );

  it(
    "a project without mysql configuration validates and generates but refuses database commands",
    async () => {
      const noDbProject = await mkdtemp(join(fixtureRoot, "e2e-mysql-nodb-"));
      try {
        await mkdir(join(noDbProject, "drizzle"), { recursive: true });
        await mkdir(join(noDbProject, "src/db/migrator/v0.0.1"), { recursive: true });
        await writeFile(
          join(noDbProject, "drizzle-migrator.config.ts"),
          `export default {\n  dialect: "mysql",\n  migratorOutDir: "./src/db/migrator",\n};\n`,
          "utf8",
        );
        await writeFile(
          join(noDbProject, "drizzle/0001_users.sql"),
          "CREATE TABLE users (id int PRIMARY KEY);",
          "utf8",
        );
        // Unclaimed by any migration: `generate --yes` below scaffolds v0.0.2 from it.
        await writeFile(
          join(noDbProject, "drizzle/0002_posts.sql"),
          "CREATE TABLE posts (id int);",
          "utf8",
        );
        await writeFile(
          join(noDbProject, "src/db/migrator/v0.0.1/index.ts"),
          migrationEntry("0.0.1", "users", ["0001_users.sql"]),
          "utf8",
        );

        process.chdir(noDbProject);
        Reflect.deleteProperty(process.env, "DATABASE_URL");

        // Connection-free commands work with no mysql configuration at all.
        await runCli(["validate"]);
        expect(process.exitCode).toBe(0);
        expect(infoOutput()).toMatch(/registry ok: 1 migration\(s\)/);

        process.exitCode = 0;
        infoSpy.mockClear();
        await runCli(["generate", "--yes"]);
        expect(process.exitCode).toBe(0);
        const generated = await import("node:fs/promises").then((fs) =>
          fs.readFile(join(noDbProject, "src/db/migrator/v0.0.2/index.ts"), "utf8"),
        );
        expect(generated).toContain('"0002_posts.sql"');

        // Database commands fail before any connection attempt.
        process.exitCode = 0;
        errorSpy.mockClear();
        await runCli(["migrate"]);
        expect(process.exitCode).toBe(1);
        expect(errorOutput()).toMatch(/command "migrate" requires a database connection/);
        expect(errorOutput()).toMatch(/"mysql\.connectionString"/);
      } finally {
        process.chdir(originalCwd);
        await rm(noDbProject, { recursive: true, force: true }).catch(() => {});
      }
    },
    TIMEOUT,
  );
});
