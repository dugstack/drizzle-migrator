import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled skill (smoke)", () => {
  it("ships a SKILL.md placeholder", () => {
    const skill = readFileSync(
      new URL("../skills/drizzle-migrator/SKILL.md", import.meta.url),
      "utf8",
    );

    expect(skill).toContain("drizzle-migrator");
    expect(skill).toContain("Milestone 6");
  });
});
