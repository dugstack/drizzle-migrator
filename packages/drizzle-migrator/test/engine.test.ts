import { describe, expect, it } from "vitest";
import { adoptMigrations, getStatus, runMigrations } from "../src/core/engine.js";

describe("core engine (smoke)", () => {
  it("exposes the engine entry points", () => {
    expect(typeof runMigrations).toBe("function");
    expect(typeof adoptMigrations).toBe("function");
    expect(typeof getStatus).toBe("function");
  });

  it("is not implemented yet", async () => {
    await expect(
      runMigrations({
        db: undefined,
        adapter: undefined as never,
        config: undefined as never,
        migrations: [],
      }),
    ).rejects.toThrow("TODO: implement in Milestone 2");
  });
});
