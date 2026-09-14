import { describe, expect, it } from "vitest";
import { DEFAULT_LOCK_NAME, defineConfig, resolveCliConfig } from "../src/index.js";

const GOOD_URL = "postgres://user:pass@localhost:5432/app";

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

  it("rejects mistyped config shapes at compile time", () => {
    const numericConnectionString = {
      dialect: "postgres",
      postgres: { connectionString: 123 },
      migratorOutDir: "./m",
    };
    // @ts-expect-error postgres.connectionString must be a string
    expect(() => defineConfig(numericConnectionString)).toThrow(/must be a string when present/);

    const wrongDialect = { dialect: "mysql", migratorOutDir: "./m" };
    // @ts-expect-error only "postgres" exists in the union in v1
    expect(() => defineConfig(wrongDialect)).toThrow(/"dialect" must be "postgres"/);
  });

  it("resolves a missing postgres block to undefined (connection-free commands still run)", () => {
    const config = resolveCliConfig({
      dialect: "postgres",
      migratorOutDir: "./m",
    });
    expect(config.postgres).toBeUndefined();
  });

  it("resolves an empty connection string to undefined instead of erroring", () => {
    // Covers the `connectionString: process.env.DATABASE_URL` pattern with the
    // env var unset: not a config error, a per-command requirement.
    const unset = resolveCliConfig({
      dialect: "postgres",
      postgres: { connectionString: process.env.NEVER_SET_VAR as string },
      migratorOutDir: "./m",
    });
    expect(unset.postgres).toBeUndefined();

    const empty = resolveCliConfig({
      dialect: "postgres",
      postgres: { connectionString: "   " },
      migratorOutDir: "./m",
    });
    expect(empty.postgres).toBeUndefined();
  });

  it("accepts a keyword (key=value) connection string", () => {
    const config = resolveCliConfig({
      dialect: "postgres",
      postgres: { connectionString: "host=localhost dbname=app" },
      migratorOutDir: "./m",
    });
    expect(config.postgres?.connectionString).toBe("host=localhost dbname=app");
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

  it("rejects a connection string that is neither a URL nor key=value", () => {
    expect(() =>
      resolveCliConfig({
        dialect: "postgres",
        postgres: { connectionString: "localhost" },
        migratorOutDir: "./m",
      }),
    ).toThrow(/key=value connection string/);
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
    expect(() => resolveCliConfig({ dialect: "sqlite", migratorOutDir: "./m" })).toThrow(
      /"dialect" must be "postgres"/,
    );
  });
});
