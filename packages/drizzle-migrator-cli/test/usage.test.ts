import { describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../src/commands.js";
import { printUsage } from "../src/usage.js";
import { createFakeLogger } from "./helpers.js";

/**
 * The single command table (src/commands.ts) is the only definition; this suite
 * pins the frozen contract itself (names + flags) and checks the usage renderer
 * covers every command and flag the table declares.
 */
describe("CLI command table", () => {
  it("matches the §7 dispatch table", () => {
    expect(CLI_COMMANDS.map((spec) => spec.name)).toEqual([
      "migrate",
      "adopt",
      "status",
      "generate",
      "validate",
    ]);
    expect(
      CLI_COMMANDS.find((spec) => spec.name === "adopt")?.flags.map((flag) => flag.name),
    ).toEqual(["from", "to", "force", "confirm-database"]);
    expect(
      CLI_COMMANDS.find((spec) => spec.name === "generate")?.flags.map((flag) => flag.name),
    ).toEqual(["version", "name", "yes", "register"]);
  });

  it("marks migrate, adopt, and status as database commands and the rest connection-free", () => {
    expect(
      Object.fromEntries(CLI_COMMANDS.map((spec) => [spec.name, spec.requiresDatabase])),
    ).toEqual({
      migrate: true,
      adopt: true,
      status: true,
      generate: false,
      validate: false,
    });
  });

  it("renders every command and flag into the usage output", () => {
    const logger = createFakeLogger();
    printUsage(logger);
    const output = logger.lines.join("\n");
    for (const command of CLI_COMMANDS) {
      expect(output).toContain(command.name);
      expect(output).toContain(command.description);
      for (const flag of command.flags) {
        expect(output).toContain(flag.type === "boolean" ? `--${flag.name}` : `--${flag.name}=`);
      }
    }
  });
});
