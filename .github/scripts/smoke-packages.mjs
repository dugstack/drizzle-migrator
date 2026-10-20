import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const consumer = mkdtempSync(join(tmpdir(), "drizzle-consumer-"));

try {
  // Pack with pnpm so workspace dependencies become installable version ranges.
  for (const pkg of ["core", "cli"]) {
    execFileSync("pnpm", ["pack", "--pack-destination", consumer], {
      cwd: join(root, "packages", pkg),
      stdio: "inherit",
    });
  }
  const core = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8"));
  const cli = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // Install outside the workspace: resolution must use packed files, never source symlinks.
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(consumer, `dugstack-drizzle-migrator-${core.version}.tgz`),
      join(consumer, `dugstack-drizzle-migrator-cli-${cli.version}.tgz`),
    ],
    {
      cwd: consumer,
      stdio: "inherit",
      timeout: 600_000,
    },
  );
  writeFileSync(
    join(consumer, "exports.mjs"),
    `
import { createMigrator } from '@dugstack/drizzle-migrator';
import { pgDialect } from '@dugstack/drizzle-migrator/pg';
import { mysqlDialect } from '@dugstack/drizzle-migrator/mysql';
import { sqliteDialect } from '@dugstack/drizzle-migrator/sqlite';
import assert from 'node:assert/strict';
assert.equal(typeof createMigrator, 'function');
for (const dialect of [pgDialect, mysqlDialect, sqliteDialect]) assert.ok(dialect);
`,
  );
  execFileSync(process.execPath, ["exports.mjs"], { cwd: consumer, stdio: "inherit" });
  mkdirSync(join(consumer, "drizzle"));
  writeFileSync(
    join(consumer, "drizzle/0000_users.sql"),
    "CREATE TABLE users (id INTEGER PRIMARY KEY);\n",
  );
  writeFileSync(
    join(consumer, "drizzle-migrator.config.ts"),
    `export default {
  dialect: 'sqlite', sqlite: { path: './app.db' },
  migratorOutDir: './migrations', drizzleOutDir: './drizzle',
};\n`,
  );
  const bin = join(consumer, "node_modules/.bin/drizzle-migrator");
  // A successful exit alone misses swallowed audit failures on fresh databases.
  const runCli = (...args) => {
    const result = spawnSync(bin, args, { cwd: consumer, encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "", `Unexpected CLI errors: ${result.stderr}`);
    return result.stdout;
  };
  runCli("generate", "--yes");
  runCli("validate");
  runCli("migrate");
  const repeated = runCli("migrate");
  assert.match(repeated, /no pending migrations/);
  const status = JSON.parse(runCli("status", "--json"));
  assert.equal(status.currentVersion, "0.0.1");
  assert.equal(status.applied.length, 1);
  assert.deepEqual(status.pending, []);
  // Confirm the generated migration executed SQL, beyond recording its version.
  writeFileSync(
    join(consumer, "verify.mjs"),
    `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.resolve('@dugstack/drizzle-migrator-cli'));
const Database = require('better-sqlite3');
const db = new Database('./app.db');
try {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get());
} finally {
  db.close();
}
`,
  );
  execFileSync(process.execPath, ["verify.mjs"], { cwd: consumer, stdio: "inherit" });
  console.log(
    "Packed consumer smoke passed: exports, generate, validate, migrate, repeat, status.",
  );
} finally {
  // Remove only this run's temporary consumer, including native dependencies.
  rmSync(consumer, { recursive: true, force: true });
}
