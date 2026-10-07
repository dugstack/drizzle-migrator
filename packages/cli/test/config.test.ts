import { describe, expect, it } from "vitest";
import {
  type CliDialect,
  DEFAULT_LOCK_NAME,
  type MigratorCliConfig,
  defineConfig,
  resolveCliConfig,
} from "../src/index.js";

const GOOD_URL = "postgres://user:pass@localhost:5432/app";
const GOOD_MYSQL_URL = "mysql://user:pass@localhost:3306/app";

/** Narrows the resolved union so dialect-specific fields are readable in tests. */
function expectDialect<D extends CliDialect>(
  config: MigratorCliConfig,
  dialect: D,
): Extract<MigratorCliConfig, { dialect: D }> {
  if (config.dialect !== dialect) {
    throw new Error(`expected dialect "${dialect}", got "${config.dialect}"`);
  }
  return config as Extract<MigratorCliConfig, { dialect: D }>;
}

describe("cli defineConfig", () => {
  it("applies the CLI defaults", () => {
    const config = defineConfig({
      dialect: "postgres",
      postgres: { connectionString: GOOD_URL },
      migratorOutDir: "./src/db/migrator",
    });
    expect(config.dialect).toBe("postgres");
    expect(config.postgres).toEqual({ connectionString: GOOD_URL });
    expect(config.migratorOutDir).toBe("./src/db/migrator");
    expect(config.lockName).toBe(DEFAULT_LOCK_NAME);
    expect(config.lockName).toBe("drizzle-migrator");
    expect(config.drizzleOutDir).toBeUndefined();
    expect(config.schema).toBeUndefined();
    expect(config.logger).toBe(console);
  });

  it("keeps explicit values", () => {
    const config = defineConfig({
      dialect: "postgres",
      postgres: { connectionString: GOOD_URL },
      migratorOutDir: "./db/migrator",
      drizzleOutDir: "./sql",
      lockName: "myapp:migrator",
      schema: "private_migrations",
    });
    expect(config.lockName).toBe("myapp:migrator");
    expect(config.drizzleOutDir).toBe("./sql");
    expect(config.schema).toBe("private_migrations");
  });

  it("resolves a mysql connection block", () => {
    const config = defineConfig({
      dialect: "mysql",
      mysql: { connectionString: GOOD_MYSQL_URL },
      migratorOutDir: "./db/migrator",
    });
    expect(config.dialect).toBe("mysql");
    expect(config.mysql).toEqual({ connectionString: GOOD_MYSQL_URL });
    expect(config.lockName).toBe(DEFAULT_LOCK_NAME);
  });

  it("resolves a sqlite connection block", () => {
    const config = defineConfig({
      dialect: "sqlite",
      sqlite: { path: "./data/app.db" },
      migratorOutDir: "./db/migrator",
    });
    expect(config.dialect).toBe("sqlite");
    expect(config.sqlite).toEqual({ path: "./data/app.db" });
    expect(config.lockName).toBe(DEFAULT_LOCK_NAME);
  });

  it("rejects mistyped config shapes at compile time", () => {
    const numericConnectionString = {
      dialect: "postgres",
      postgres: { connectionString: 123 },
      migratorOutDir: "./m",
    };
    // @ts-expect-error postgres.connectionString must be a string
    expect(() => defineConfig(numericConnectionString)).toThrow(/must be a string when present/);

    const wrongDialect = { dialect: "mongodb", migratorOutDir: "./m" };
    // @ts-expect-error "mongodb" is not in the dialect union
    expect(() => defineConfig(wrongDialect)).toThrow(
      /"dialect" must be one of "postgres", "mysql", "sqlite"/,
    );
  });

  it("resolves a missing connection block to undefined (connection-free commands still run)", () => {
    expect(
      expectDialect(resolveCliConfig({ dialect: "postgres", migratorOutDir: "./m" }), "postgres")
        .postgres,
    ).toBeUndefined();
    expect(
      expectDialect(resolveCliConfig({ dialect: "mysql", migratorOutDir: "./m" }), "mysql").mysql,
    ).toBeUndefined();
    expect(
      expectDialect(resolveCliConfig({ dialect: "sqlite", migratorOutDir: "./m" }), "sqlite")
        .sqlite,
    ).toBeUndefined();
  });

  it("resolves an empty connection string to undefined instead of erroring", () => {
    // Covers the `connectionString: process.env.DATABASE_URL` pattern with the
    // env var unset: not a config error, a per-command requirement.
    const unset = resolveCliConfig({
      dialect: "postgres",
      postgres: { connectionString: process.env.NEVER_SET_VAR as string },
      migratorOutDir: "./m",
    });
    expect(expectDialect(unset, "postgres").postgres).toBeUndefined();

    const empty = resolveCliConfig({
      dialect: "postgres",
      postgres: { connectionString: "   " },
      migratorOutDir: "./m",
    });
    expect(expectDialect(empty, "postgres").postgres).toBeUndefined();

    const emptyMysql = resolveCliConfig({
      dialect: "mysql",
      mysql: { connectionString: "   " },
      migratorOutDir: "./m",
    });
    expect(expectDialect(emptyMysql, "mysql").mysql).toBeUndefined();

    const emptySqlite = resolveCliConfig({
      dialect: "sqlite",
      sqlite: { path: "   " },
      migratorOutDir: "./m",
    });
    expect(expectDialect(emptySqlite, "sqlite").sqlite).toBeUndefined();
  });

  it("accepts a keyword (key=value) connection string", () => {
    const config = resolveCliConfig({
      dialect: "postgres",
      postgres: { connectionString: "host=localhost dbname=app" },
      migratorOutDir: "./m",
    });
    if (config.dialect !== "postgres") {
      throw new Error("expected the postgres member");
    }
    expect(config.postgres?.connectionString).toBe("host=localhost dbname=app");
  });

  it("accepts the mariadb URL scheme for the mysql dialect", () => {
    const config = resolveCliConfig({
      dialect: "mysql",
      mysql: { connectionString: "mariadb://user:pass@localhost/app" },
      migratorOutDir: "./m",
    });
    if (config.dialect !== "mysql") {
      throw new Error("expected the mysql member");
    }
    expect(config.mysql?.connectionString).toBe("mariadb://user:pass@localhost/app");
  });
});

describe("cli config validation (runtime, on loaded exports)", () => {
  it("rejects a non-object export", () => {
    expect(() => resolveCliConfig(undefined)).toThrow(/expected an object/);
    expect(() => resolveCliConfig("nope")).toThrow(/expected an object/);
  });

  it("rejects a non-object postgres block", () => {
    expect(() =>
      resolveCliConfig({ dialect: "postgres", postgres: "nope", migratorOutDir: "./m" }),
    ).toThrow(/"postgres" must be an object/);
  });

  it("rejects a non-object sqlite block", () => {
    expect(() =>
      resolveCliConfig({ dialect: "sqlite", sqlite: 123, migratorOutDir: "./m" }),
    ).toThrow(/"sqlite" must be an object/);
  });

  it("rejects a non-string connection string", () => {
    expect(() =>
      resolveCliConfig({
        dialect: "postgres",
        postgres: { connectionString: 123 },
        migratorOutDir: "./m",
      }),
    ).toThrow(/"postgres.connectionString" must be a string when present/);
  });

  it("rejects a non-postgres URL scheme", () => {
    expect(() =>
      resolveCliConfig({
        dialect: "postgres",
        postgres: { connectionString: "mysql://user:pass@localhost/app" },
        migratorOutDir: "./m",
      }),
    ).toThrow(/scheme "mysql" is not postgres/);
    expect(() =>
      resolveCliConfig({
        dialect: "postgres",
        postgres: { connectionString: "postgresql://localhost/app" },
        migratorOutDir: "./m",
      }),
    ).not.toThrow();
  });

  it("rejects a non-mysql URL scheme", () => {
    expect(() =>
      resolveCliConfig({
        dialect: "mysql",
        mysql: { connectionString: "postgres://user:pass@localhost/app" },
        migratorOutDir: "./m",
      }),
    ).toThrow(/scheme "postgres" is not mysql/);
  });

  it("rejects a connection string that is neither a URL nor key=value", () => {
    expect(() =>
      resolveCliConfig({
        dialect: "postgres",
        postgres: { connectionString: "localhost" },
        migratorOutDir: "./m",
      }),
    ).toThrow(/key=value connection string/);
  });

  it("rejects URLs in the sqlite path", () => {
    expect(() =>
      resolveCliConfig({
        dialect: "sqlite",
        sqlite: { path: "file:///tmp/app.db" },
        migratorOutDir: "./m",
      }),
    ).toThrow(/"sqlite.path" must be an absolute filesystem path/);
  });

  it("rejects a connection block that does not match the dialect", () => {
    expect(() =>
      resolveCliConfig({
        dialect: "postgres",
        mysql: { connectionString: GOOD_MYSQL_URL },
        migratorOutDir: "./m",
      }),
    ).toThrow(/"mysql" connection block requires "dialect": "mysql"/);
    expect(() =>
      resolveCliConfig({
        dialect: "mysql",
        sqlite: { path: "./app.db" },
        migratorOutDir: "./m",
      }),
    ).toThrow(/"sqlite" connection block requires "dialect": "sqlite"/);
  });

  it("requires migratorOutDir", () => {
    expect(() =>
      resolveCliConfig({ dialect: "postgres", postgres: { connectionString: GOOD_URL } }),
    ).toThrow(/"migratorOutDir" is required/);
  });

  it("rejects URLs in path fields", () => {
    expect(() =>
      resolveCliConfig({
        dialect: "postgres",
        postgres: { connectionString: GOOD_URL },
        migratorOutDir: "./m",
        drizzleOutDir: "https://example.com/drizzle",
      }),
    ).toThrow(/"drizzleOutDir" must be an absolute filesystem path/);
  });

  it("rejects an unknown dialect with the supported list", () => {
    expect(() => resolveCliConfig({ dialect: "mongodb", migratorOutDir: "./m" })).toThrow(
      /"dialect" must be one of "postgres", "mysql", "sqlite"/,
    );
  });
});
