import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigratorLogger } from "@dugstack/drizzle-migrator";

export type FakeLogger = MigratorLogger & {
  lines: string[];
  errors: string[];
};

export function createFakeLogger(): FakeLogger {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    info: (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    },
  };
}

/**
 * Fixture projects live under the package's test dir so that migration entries
 * importing "@dugstack/drizzle-migrator" resolve through the workspace
 * node_modules when loaded via jiti.
 */
export const packageRoot = fileURLToPath(new URL("..", import.meta.url));
export const fixtureRoot = join(packageRoot, "test", ".tmp");

export async function makeFixtureProject(prefix: string): Promise<string> {
  await mkdir(fixtureRoot, { recursive: true });
  return mkdtemp(join(fixtureRoot, `${prefix}-`));
}

export async function writeFileTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

export async function removeFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** A valid plain-object config body; the runner re-validates raw exports. */
export function configModule(connectionString = "postgres://user:pass@localhost:5432/app"): string {
  return `export default {
  dialect: "postgres",
  postgres: { connectionString: ${JSON.stringify(connectionString)} },
  migratorOutDir: "./src/db/migrator",
};
`;
}

export function migrationEntry(version: string, name: string, sqlFiles: string[] = []): string {
  const exportName = `migration_v${version.replaceAll(".", "_")}`;
  const files = sqlFiles.map((file) => JSON.stringify(file)).join(", ");
  const runCalls = sqlFiles
    .map((file) => `      await ctx.runSqlFile(${JSON.stringify(file)});`)
    .join("\n");
  return `import { defineMigration } from "@dugstack/drizzle-migrator";

export const ${exportName} = defineMigration({
  version: ${JSON.stringify(version)},
  name: ${JSON.stringify(name)},
${sqlFiles.length > 0 ? `  sqlFiles: [${files}],\n` : ""}  async up(ctx) {
${runCalls.length > 0 ? `${runCalls}\n` : '    await ctx.execute("SELECT 1");\n'}  },
});
`;
}
