import { describe, expectTypeOf, it } from "vitest";
import { defineMigration } from "../src/core/index.js";

describe("typed sqlFiles contract (smoke)", () => {
  it("infers literal sqlFiles from the array literal", () => {
    const migration = defineMigration({
      version: "0.0.1",
      name: "smoke",
      sqlFiles: ["0001_smoke.sql"],
      async up(ctx) {
        await ctx.runSqlFile("0001_smoke.sql");
      },
    });

    expectTypeOf(migration.sqlFiles).toEqualTypeOf<readonly ["0001_smoke.sql"]>();
  });

  it("locks runSqlFile to never when sqlFiles is omitted", () => {
    const migration = defineMigration({
      version: "0.0.2",
      name: "smoke-no-files",
      async up(ctx) {
        expectTypeOf(ctx.runSqlFile).parameter(0).toEqualTypeOf<never>();
      },
    });

    expectTypeOf(migration.sqlFiles).toEqualTypeOf<readonly []>();
  });

  it("restricts runSqlFile to the declared file names", () => {
    const migration = defineMigration({
      version: "0.0.3",
      name: "smoke-params",
      sqlFiles: ["0003_a.sql", "0003_b.sql"],
      async up(ctx) {
        expectTypeOf(ctx.runSqlFile).parameter(0).toEqualTypeOf<"0003_a.sql" | "0003_b.sql">();
      },
    });

    expectTypeOf(migration.sqlFiles).toEqualTypeOf<readonly ["0003_a.sql", "0003_b.sql"]>();
  });
});
