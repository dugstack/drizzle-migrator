import { describe, expect, it } from "vitest";
import { createMigrationCli } from "../src/core/cli.js";

describe("cli factory (smoke)", () => {
  it("exposes createMigrationCli", () => {
    expect(typeof createMigrationCli).toBe("function");
  });
});
