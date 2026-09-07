import { describe, expect, it } from "vitest";
import * as pg from "../src/pg/index.js";

describe("pg entry (smoke)", () => {
  it("exposes the §7 public surface", () => {
    const names = [
      "runMigrations",
      "adoptMigrations",
      "getStatus",
      "generateMigrationEntry",
      "createMigrationCli",
      "defineConfig",
      "defineMigration",
    ];

    for (const name of names) {
      expect(typeof (pg as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
