import { describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../../drizzle-migrator/src/core/cli.js";
import { USAGE_COMMANDS, printUsage } from "../src/usage.js";
import { createFakeLogger } from "./helpers.js";

/**
 * The executable prints its own usage (it cannot import the core's internal
 * dispatch table through the public export map), so the table is mirrored here.
 * This test is the drift guard: the mirrored table must stay byte-identical to
 * the core CLI dispatch table — same contract as the core's skill-sync test.
 */
describe("usage table sync with the core CLI dispatch table", () => {
  it("matches command-for-command", () => {
    expect(USAGE_COMMANDS.map((command) => command.name)).toEqual(
      CLI_COMMANDS.map((command) => command.name),
    );
    for (const [index, core] of CLI_COMMANDS.entries()) {
      const mirrored = USAGE_COMMANDS[index];
      expect(mirrored?.description).toBe(core.description);
      expect(mirrored?.flags.map((flag) => [flag.name, flag.type])).toEqual(
        core.flags.map((flag) => [flag.name, flag.type]),
      );
      expect(mirrored?.flags.map((flag) => flag.description)).toEqual(
        core.flags.map((flag) => flag.description),
      );
    }
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
