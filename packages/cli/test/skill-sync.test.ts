import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS } from "../src/commands.js";

const skill = readFileSync(new URL("../skills/drizzle-migrator/SKILL.md", import.meta.url), "utf8");

type CommandRow = { command: string; flags: string[] };

function parseCommandTable(content: string): CommandRow[] {
  const rows: CommandRow[] = [];
  for (const line of content.split("\n")) {
    const match = /^\| `([a-z-]+)` \| (.*) \|$/u.exec(line.trim());
    if (!match) {
      continue;
    }
    const command = match[1] ?? "";
    const flags = [...(match[2] ?? "").matchAll(/--([a-z-]+)=?/gu)].map((flag) => flag[1] ?? "");
    rows.push({ command, flags });
  }
  return rows;
}

describe("bundled skill sync", () => {
  it("ships the real SKILL.md identifying the CLI package", () => {
    expect(skill).toContain("name: drizzle-migrator-cli");
    expect(skill).toContain("# drizzle-migrator-cli");
    expect(skill).toContain("@dugstack/drizzle-migrator-cli");
  });

  it("command table matches the CLI command table exactly", () => {
    const rows = parseCommandTable(skill);
    expect(rows.map((row) => row.command)).toEqual(CLI_COMMANDS.map((spec) => spec.name));

    for (const [index, row] of rows.entries()) {
      const spec = CLI_COMMANDS[index];
      expect(row.flags, `flags for command "${row.command}" in SKILL.md`).toEqual(
        spec?.flags.map((flag) => flag.name) ?? [],
      );
    }
  });

  it("never documents a flag the CLI does not have", () => {
    const known = new Set(CLI_COMMANDS.flatMap((spec) => spec.flags.map((flag) => flag.name)));
    for (const match of skill.matchAll(/--([a-z][a-z-]*)/gu)) {
      const flag = match[1] ?? "";
      expect(known.has(flag), `SKILL.md documents --${flag} but the CLI has no such flag`).toBe(
        true,
      );
    }
  });

  it("never omits a CLI flag from the command table (no stale table entries)", () => {
    const rows = parseCommandTable(skill);
    for (const spec of CLI_COMMANDS) {
      const row = rows.find((candidate) => candidate.command === spec.name);
      expect(row, `SKILL.md has no row for command "${spec.name}"`).toBeDefined();
      for (const flag of spec.flags) {
        expect(
          row?.flags.includes(flag.name),
          `SKILL.md command "${spec.name}" is missing flag --${flag.name}`,
        ).toBe(true);
      }
    }
  });

  it("documents the operational rules verbatim", () => {
    for (const rule of [
      "Never edit an applied migration",
      "Never change `lockName` after deployment",
      "Never run migrations from application startup",
    ]) {
      expect(skill).toContain(rule);
    }
  });
});
