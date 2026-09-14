import { describe, expect, it } from "vitest";
import { type MigratorConfigInput, type MigratorLogger, defineConfig } from "../src/core/config.js";
import { createMigrator } from "../src/core/index.js";
import { createFakeAdapter, createFakeDatabase } from "./fake-adapter.js";

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

  it("validates schema and table names through the dialect", () => {
    const dialect = createFakeAdapter(createFakeDatabase());
    dialect.quoteIdentifier = (identifier) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
        throw new Error(`invalid identifier: ${identifier}`);
      }
      return `\"${identifier}\"`;
    };

    expect(() =>
      createMigrator({
        dialect,
        config: defineConfig({ lockName: "x", schema: "Migrations" }),
        migrations: [],
      }),
    ).toThrow(/invalid identifier: Migrations/);
    expect(() =>
      createMigrator({
        dialect,
        config: defineConfig({ lockName: "x", tables: { versions: "versions-1", logs: "logs" } }),
        migrations: [],
      }),
    ).toThrow(/invalid identifier: versions-1/);
    expect(() =>
      createMigrator({
        dialect,
        config: defineConfig({ lockName: "x", tables: { versions: "v", logs: "l;og" } }),
        migrations: [],
      }),
    ).toThrow(/invalid identifier: l;og/);
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
    expect(() => defineConfig({ lockName: "", sqlDir: "http://x" })).toThrow(
      /invalid migrator config:\n- "lockName".*- "sqlDir"/s,
    );
  });
});
