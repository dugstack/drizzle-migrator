import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliConfig, resolveSqlDir } from "../src/index.js";
import { createModuleLoader } from "../src/loader.js";
import {
  configModule,
  createFakeLogger,
  makeFixtureProject,
  removeFixture,
  writeFileTree,
} from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => removeFixture(root)));
});

async function newProject(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await makeFixtureProject(prefix);
  cleanup.push(root);
  await writeFileTree(root, files);
  return root;
}

async function resolveFor(root: string, overrides: Record<string, unknown> = {}) {
  const configPath = join(root, "drizzle-migrator.config.ts");
  const loader = createModuleLoader(configPath);
  const { default: raw } = (await loader(configPath)) as { default: Record<string, unknown> };
  const cli = resolveCliConfig({ ...raw, ...overrides });
  const logger = createFakeLogger();
  const sqlDir = await resolveSqlDir({ cli, cwd: root, loader, logger });
  return { sqlDir, logger };
}

describe("sqlDir resolution (drizzleOutDir vs drizzle config vs default)", () => {
  it("drizzleOutDir wins over the drizzle config's out", async () => {
    const root = await newProject("sqldir-manual-wins", {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle.config.ts": 'export default { out: "./from-drizzle-kit" };\n',
    });
    const { sqlDir } = await resolveFor(root, { drizzleOutDir: "./manual-out" });
    expect(sqlDir).toBe("./manual-out");
  });

  it("reads out from a drizzle.config.ts default export", async () => {
    const root = await newProject("sqldir-drizzle-default", {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle.config.ts": 'export default { out: "./from-drizzle-kit" };\n',
    });
    const { sqlDir } = await resolveFor(root);
    expect(sqlDir).toBe("./from-drizzle-kit");
  });

  it("reads out from a named export when there is no default", async () => {
    const root = await newProject("sqldir-drizzle-named", {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle.config.ts": 'export const out = "./named-out";\n',
    });
    const { sqlDir } = await resolveFor(root);
    expect(sqlDir).toBe("./named-out");
  });

  it("reads out from a drizzle.config.json", async () => {
    const root = await newProject("sqldir-drizzle-json", {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle.config.json": '{ "out": "./json-out" }\n',
    });
    const { sqlDir } = await resolveFor(root);
    expect(sqlDir).toBe("./json-out");
  });

  it("falls back to ./drizzle when the drizzle config has no usable out", async () => {
    const root = await newProject("sqldir-drizzle-no-out", {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle.config.ts": 'export default { dialect: "postgresql" };\n',
    });
    const { sqlDir, logger } = await resolveFor(root);
    expect(sqlDir).toBe("./drizzle");
    expect(logger.lines.join("\n")).toMatch(/no usable "out" field/);
  });

  it("falls back to ./drizzle when no drizzle config exists", async () => {
    const root = await newProject("sqldir-no-drizzle-config", {
      "drizzle-migrator.config.ts": configModule(),
    });
    const { sqlDir, logger } = await resolveFor(root);
    expect(sqlDir).toBe("./drizzle");
    expect(logger.lines.join("\n")).toMatch(
      /no drizzleOutDir configured and no drizzle\.config\.\*/,
    );
  });

  it("propagates a broken drizzle config instead of silently falling back", async () => {
    const root = await newProject("sqldir-broken-drizzle", {
      "drizzle-migrator.config.ts": configModule(),
      "drizzle.config.ts": "throw new Error('broken drizzle config');\n",
    });
    await expect(resolveFor(root)).rejects.toThrow(/broken drizzle config/);
  });
});
