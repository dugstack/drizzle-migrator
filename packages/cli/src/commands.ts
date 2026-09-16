/**
 * The single source of truth for the migrator CLI. Command dispatch, flag
 * validation, usage rendering, and the README/skill sync tests all read this
 * one table — a command or flag change lands here and everywhere else follows.
 * Command names and flags are a frozen contract (see SKILL.md §8 and the base
 * plan's §7 table).
 */
export type CliFlagType = "boolean" | "value";

export type CliFlagSpec = {
  name: string;
  type: CliFlagType;
  description: string;
};

export type CliCommandSpec = {
  name: string;
  description: string;
  /** True when the command cannot run without `postgres.connectionString`. */
  requiresDatabase: boolean;
  flags: readonly CliFlagSpec[];
};

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    name: "migrate",
    description: "apply pending migrations; the only command a deploy pipeline runs",
    requiresDatabase: true,
    flags: [
      {
        name: "dry-run",
        type: "boolean",
        description: "print the statements that would run without executing anything",
      },
    ],
  },
  {
    name: "adopt",
    description: "record an existing database as already-migrated without executing SQL",
    requiresDatabase: true,
    flags: [
      {
        name: "from",
        type: "value",
        description: "first version to adopt (default: registry first)",
      },
      { name: "to", type: "value", description: "last version to adopt (default: registry last)" },
      {
        name: "force",
        type: "boolean",
        description: "continue adopting above the highest recorded version",
      },
      {
        name: "confirm-database",
        type: "value",
        description: "must match the connected database name (safety guard)",
      },
    ],
  },
  {
    name: "status",
    description: "show the current version, applied and pending migrations, recent audit logs",
    requiresDatabase: true,
    flags: [{ name: "json", type: "boolean", description: "print the status report as JSON" }],
  },
  {
    name: "generate",
    description: "scaffold a new migration entry from unapplied SQL files in sqlDir",
    requiresDatabase: false,
    flags: [
      { name: "version", type: "value", description: "skip the version prompt" },
      { name: "name", type: "value", description: "skip the name prompt" },
      { name: "yes", type: "boolean", description: "skip all prompts and use every default" },
      {
        name: "register",
        type: "boolean",
        description: "append the import + entry to the versions registry",
      },
    ],
  },
  {
    name: "validate",
    description: "lint the migration registry: versions, duplicates, sqlFiles, file existence",
    requiresDatabase: false,
    flags: [],
  },
];

export type ParsedCommandArgv = {
  command: string;
  flags: Record<string, string | boolean>;
};

/** Parses the command token and its `--flags` (`--flag`, `--flag=value`, `-y` alias for `--yes`). */
export function parseCommandArgv(argv: readonly string[]): ParsedCommandArgv {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (const arg of rest) {
    if (arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument "${arg}" — only --flags are accepted`);
    }
    const body = arg.slice(2);
    if (body.length === 0) {
      throw new Error(`empty flag "${arg}"`);
    }
    const equals = body.indexOf("=");
    if (equals === -1) {
      flags[body] = true;
      continue;
    }
    const key = body.slice(0, equals);
    const value = body.slice(equals + 1);
    if (key.length === 0) {
      throw new Error(`empty flag key in "${arg}"`);
    }
    if (value.length === 0) {
      throw new Error(`flag "--${key}=" has an empty value`);
    }
    flags[key] = value;
  }

  return { command, flags };
}

/** Secret-looking flag values never reach the audit trail. */
export function redactFlags(
  flags: Record<string, string | boolean>,
): Record<string, string | boolean> {
  const redacted: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(flags)) {
    redacted[key] =
      typeof value === "string" && /password|secret|token|api[-_]?key/i.test(key)
        ? "[redacted]"
        : value;
  }
  return redacted;
}

export function flagList(spec: CliCommandSpec): string {
  return spec.flags.map((flag) => `--${flag.name}`).join(", ");
}

/** Rejects unknown flags and mistyped values against the command table entry. */
export function validateCommandFlags(
  spec: CliCommandSpec,
  flags: Record<string, string | boolean>,
): void {
  const allowed = new Set(spec.flags.map((flag) => flag.name));
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw new Error(
        `unknown flag "--${key}" for command "${spec.name}" (supported: ${flagList(spec) || "none"})`,
      );
    }
  }
  for (const flag of spec.flags) {
    const value = flags[flag.name];
    if (value === undefined) {
      continue;
    }
    if (flag.type === "boolean" && typeof value !== "boolean") {
      throw new Error(`flag "--${flag.name}" takes no value`);
    }
    if (flag.type === "value" && typeof value !== "string") {
      throw new Error(`flag "--${flag.name}" requires a value (--${flag.name}=<value>)`);
    }
  }
}
