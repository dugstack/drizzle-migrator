import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
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
const PG_IMAGE = "postgres:16-alpine";

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
    "[cli.pg.integration] Docker is not reachable — skipping testcontainers end-to-end tests (CI runs them with Docker).",
  );
}

const suite = describe.skipIf(!dockerAvailable);

const originalCwd = process.cwd();
let infoSpy: MockInstance;
let errorSpy: MockInstance;

suite("cli end-to-end (testcontainers)", () => {
  let container: StartedPostgreSqlContainer;
  let adminClient: Client;
  let project: string;
  let fixtureDatabaseUri: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(PG_IMAGE).start();
    adminClient = new Client({ connectionString: container.getConnectionUri() });
    await adminClient.connect();
    await adminClient.query("CREATE DATABASE e2ecli");
    const uri = new URL(container.getConnectionUri());
    uri.pathname = "/e2ecli";
    fixtureDatabaseUri = uri.toString();

    // A realistic consumer project: no drizzleOutDir, no drizzle.config — the
    // SQL directory falls back to ./drizzle; no manual registry file; the
    // config reads DATABASE_URL from the environment like the plan's example.
    project = await mkdtemp(join(fixtureRoot, "e2e-"));
    await mkdir(join(project, "drizzle"), { recursive: true });
    await mkdir(join(project, "src/db/migrator/v0.0.1"), { recursive: true });
    await writeFile(
      join(project, "drizzle-migrator.config.ts"),
      `export default {
  dialect: "postgres",
  postgres: { connectionString: process.env.DATABASE_URL },
  migratorOutDir: "./src/db/migrator",
};
`,
      "utf8",
    );
    await writeFile(
      join(project, "drizzle/0001_users.sql"),
      "CREATE TABLE users (id int PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO users (id) VALUES (1);",
      "utf8",
    );
    await writeFile(
      join(project, "src/db/migrator/v0.0.1/index.ts"),
      migrationEntry("0.0.1", "users", ["0001_users.sql"]),
      "utf8",
    );
  }, TIMEOUT);

  afterAll(async () => {
    process.chdir(originalCwd);
    Reflect.deleteProperty(process.env, "DATABASE_URL");
    await adminClient.end().catch(() => {});
    await container.stop().catch(() => {});
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

  function infoCalls(): string[] {
    return infoSpy.mock.calls.flatMap((call) => call.map(String)) as string[];
  }

  function infoOutput(): string {
    return infoCalls().join("\n");
  }

  function errorOutput(): string {
    return errorSpy.mock.calls.flatMap((call) => call.map(String)).join("\n");
  }

  function jsonReport(): { currentVersion: string | null } | undefined {
    for (const line of infoCalls()) {
      try {
        const parsed: unknown = JSON.parse(line);
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

      const client = new Client({ connectionString: fixtureDatabaseUri });
      await client.connect();
      try {
        const users = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM users",
        );
        expect(users.rows[0]?.count).toBe("1");
        const versions = await client.query<{ version: string; origin: string }>(
          'SELECT version, origin FROM "migrations"."migration_versions" ORDER BY version',
        );
        expect(versions.rows).toEqual([{ version: "0.0.1", origin: "executed" }]);
      } finally {
        await client.end();
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
      const report = jsonReport();
      expect(report?.currentVersion).toBe("0.0.1");

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
      const generated = await readFile(join(project, "src/db/migrator/v0.0.2/index.ts"), "utf8");
      expect(generated).toMatch(/export const migration_v0_0_2 = defineMigration\(/);
      expect(generated).toContain('"0002_posts.sql"');

      process.exitCode = 0;
      infoSpy.mockClear();
      await runCli(["migrate"]);
      expect(process.exitCode).toBe(0);
      expect(infoOutput()).toMatch(/applied 1: 0\.0\.2/);
      const verifyClient = new Client({ connectionString: fixtureDatabaseUri });
      await verifyClient.connect();
      try {
        await verifyClient.query("SELECT 1 FROM posts");
        const versions = await verifyClient.query<{ version: string; origin: string }>(
          'SELECT version, origin FROM "migrations"."migration_versions" ORDER BY version',
        );
        expect(versions.rows).toEqual([
          { version: "0.0.1", origin: "executed" },
          { version: "0.0.2", origin: "executed" },
        ]);
      } finally {
        await verifyClient.end();
      }
    },
    TIMEOUT,
  );

  it(
    "fails with exit code 1 when the database is unreachable",
    async () => {
      process.chdir(project);
      process.env.DATABASE_URL = "postgres://127.0.0.1:1/e2ecli";

      await runCli(["status"]);
      expect(process.exitCode).toBe(1);
      expect(errorOutput()).toMatch(/ECONNREFUSED|error|timeout/s);
    },
    TIMEOUT,
  );
});
