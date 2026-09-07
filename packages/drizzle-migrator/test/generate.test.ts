import { describe, expect, it } from "vitest";
import { generateMigrationEntry } from "../src/core/generate.js";

describe("generate (smoke)", () => {
  it("exposes generateMigrationEntry", () => {
    expect(typeof generateMigrationEntry).toBe("function");
  });
});
