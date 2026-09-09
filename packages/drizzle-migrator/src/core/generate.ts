import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { MigratorConfig } from "./config.js";
import type { Migration } from "./migration.js";
import { compareVersions, sqlFilesOf } from "./registry.js";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DEFAULT_NAME = "pending-migration";
const REGISTRY_ARRAY_PATTERN = /(export const migrations\b[^=]*=\s*\[)([^\]]*?)(\]\s*;)/;

export type GeneratePrompts = {
  askVersion: (defaultValue: string) => Promise<string>;
  askName: (defaultValue: string) => Promise<string>;
};

export type GenerateResult = {
  version: string;
  name: string;
  entryPath: string;
  sqlFiles: string[];
  registered: boolean;
};

export type GenerateMigrationEntryOptions = {
  config: MigratorConfig;
  migrations: readonly Migration[];
  version?: string;
  name?: string;
  yes?: boolean;
  register?: boolean;
  prompts?: GeneratePrompts;
};

export function canonicalExportName(version: string): string {
  return `migration_v${version.replaceAll(".", "_")}`;
}

async function askWithDefault(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer.length > 0 ? answer : fallback;
  } finally {
    rl.close();
  }
}

const defaultPrompts: GeneratePrompts = {
  askVersion: (defaultValue) => askWithDefault(`Version [${defaultValue}]: `, defaultValue),
  askName: (defaultValue) => askWithDefault(`Name [${defaultValue}]: `, defaultValue),
};

async function scanSqlFiles(sqlDir: string): Promise<string[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(sqlDir, { withFileTypes: true });
  } catch {
    throw new Error(`generate: sqlDir ${sqlDir} not found`);
  }
  return dirents
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".sql"))
    .map((dirent) => dirent.name)
    .sort();
}

function nextPatchVersion(migrations: readonly Migration[]): string {
  const versions = migrations
    .map((migration) => migration.version)
    .filter((version) => VERSION_PATTERN.test(version))
    .sort(compareVersions);
  const highest = versions.at(-1);
  if (highest === undefined) {
    return "0.0.1";
  }
  const parts = highest.split(".").map((part) => Number.parseInt(part, 10));
  return `${parts[0] ?? 0}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`;
}

function renderEntry(version: string, name: string, files: readonly string[]): string {
  const exportName = canonicalExportName(version);
  const runCalls = files
    .map((file) => `    await ctx.runSqlFile(${JSON.stringify(file)});`)
    .join("\n");
  const fileList = files.map((file) => JSON.stringify(file)).join(", ");
  return `import { defineMigration } from "@dugstack/drizzle-migrator";

export const ${exportName} = defineMigration({
  version: ${JSON.stringify(version)},
  name: ${JSON.stringify(name)},
  sqlFiles: [${fileList}],
  async up(ctx) {
${runCalls}
  },
});
`;
}

function printRegisterSnippet(logger: MigratorConfig["logger"], version: string): void {
  const exportName = canonicalExportName(version);
  logger.info("register the new migration in the versions registry (index.ts):");
  logger.info(`  import { ${exportName} } from "./v${version}/index.js";`);
  logger.info(`  then add ${exportName} to the migrations array`);
}

async function appendToRegistry(
  config: MigratorConfig,
  version: string,
  exportName: string,
): Promise<boolean> {
  const registryPath = join(config.migrationsDir, "index.ts");
  let content: string;
  try {
    content = await readFile(registryPath, "utf8");
  } catch {
    return false;
  }

  const match = REGISTRY_ARRAY_PATTERN.exec(content);
  if (!match) {
    return false;
  }
  const before = match[1] ?? "";
  const inner = match[2] ?? "";
  const after = match[3] ?? "";
  const start = match.index;
  const end = start + match[0].length;

  const entries = inner
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.includes(exportName)) {
    return true;
  }
  entries.push(exportName);

  const renderedArray = `${before}\n${entries.map((entry) => `  ${entry}`).join(",\n")},\n${after}`;
  let updated = `${content.slice(0, start)}${renderedArray}${content.slice(end)}`;

  const importLine = `import { ${exportName} } from "./v${version}/index.js";`;
  if (!updated.includes(importLine)) {
    const lines = updated.split("\n");
    let insertAt = 0;
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]?.startsWith("import ")) {
        insertAt = index + 1;
      }
    }
    lines.splice(insertAt, 0, importLine);
    updated = lines.join("\n");
  }

  await writeFile(registryPath, updated, "utf8");
  return true;
}

export async function generateMigrationEntry(
  options: GenerateMigrationEntryOptions,
): Promise<GenerateResult> {
  const { config, migrations, version, name, yes = false, register = false } = options;
  const prompts = options.prompts ?? defaultPrompts;
  const logger = config.logger;

  const allSqlFiles = await scanSqlFiles(config.sqlDir);
  const claimed = new Set<string>();
  for (const migration of migrations) {
    for (const file of sqlFilesOf(migration)) {
      claimed.add(file);
    }
  }
  const unapplied = allSqlFiles.filter((file) => !claimed.has(file));

  const defaultVersion = nextPatchVersion(migrations);

  let chosenVersion: string;
  if (version !== undefined) {
    chosenVersion = version;
  } else if (yes) {
    chosenVersion = defaultVersion;
  } else {
    chosenVersion = await prompts.askVersion(defaultVersion);
  }
  if (!VERSION_PATTERN.test(chosenVersion)) {
    throw new Error(
      `generate: version ${JSON.stringify(chosenVersion)} must match \\d+\\.\\d+\\.\\d+`,
    );
  }

  let chosenName: string;
  if (name !== undefined) {
    chosenName = name;
  } else if (yes) {
    chosenName = DEFAULT_NAME;
  } else {
    chosenName = await prompts.askName(DEFAULT_NAME);
  }
  if (!KEBAB_CASE_PATTERN.test(chosenName)) {
    throw new Error(
      `generate: name ${JSON.stringify(chosenName)} must be kebab-case (${KEBAB_CASE_PATTERN.source})`,
    );
  }

  const entryDir = join(config.migrationsDir, `v${chosenVersion}`);
  const entryPath = join(entryDir, "index.ts");
  let entryExists = false;
  try {
    await stat(entryDir);
    entryExists = true;
  } catch {
    entryExists = false;
  }
  if (entryExists) {
    throw new Error(
      `generate: migration entry for version ${chosenVersion} already exists (${entryDir}) — never overwrite an existing entry`,
    );
  }

  if (unapplied.length === 0) {
    throw new Error(
      `generate: no unapplied SQL files in ${config.sqlDir} — every top-level *.sql file is already claimed by a registered migration`,
    );
  }

  await mkdir(entryDir, { recursive: true });
  await writeFile(entryPath, renderEntry(chosenVersion, chosenName, unapplied), "utf8");

  let registered = false;
  if (register) {
    registered = await appendToRegistry(config, chosenVersion, canonicalExportName(chosenVersion));
  }
  if (!registered) {
    printRegisterSnippet(logger, chosenVersion);
  }

  return { version: chosenVersion, name: chosenName, entryPath, sqlFiles: unapplied, registered };
}
