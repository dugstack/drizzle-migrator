# @dugstack/drizzle-migrator-cli

## 0.2.1

### Patch Changes

- Externalize the optional mysql and sqlite drivers in the published bundle. tsup auto-externalizes
  dependencies and peerDependencies but bundles optionalDependencies, so the 0.2.0 tarball inlined
  better-sqlite3 (CJS) into the ESM output and every mysql/sqlite command failed at first use with
  "Dynamic require of \"fs\" is not supported" — even with the driver installed. The drivers now
  stay runtime-resolved imports exactly like the lazy-loading design intends; verified against the
  built dist for both dialects.

## 0.2.0

### Minor Changes

- Support the mysql and sqlite dialects in the CLI. `drizzle-migrator.config.ts` now accepts
  `dialect: "mysql"` (with an optional `mysql.connectionString`, a `mysql://` or `mariadb://` URL)
  and `dialect: "sqlite"` (with an optional `sqlite.path` database file path) alongside the
  existing postgres block; a block that does not match `dialect` is a config error. The mysql and
  sqlite drivers ship as optional dependencies and load lazily — a postgres-only install never
  touches them, and an omitted optional dependency fails with an install hint. Every database
  command still runs on one dedicated session-scoped connection per invocation, which the
  session-scoped advisory locks of both server dialects require. mysql and sqlite end-to-end CLI
  suites cover migrate, status, generate, the validate audit trail, and the no-connection
  refusals.

## 0.1.4

### Patch Changes

- Make the published manifest installable. `npm stage publish` does not rewrite pnpm's
  `workspace:` protocol (only `pnpm publish` does), so the 0.1.3 release shipped
  `"@dugstack/drizzle-migrator": "workspace:^"` and failed `npm install` outside a pnpm
  workspace. The stage pipeline now resolves workspace specs against the workspace
  packages before packing, and this release publishes the resolved `^0.3.0` range.

## 0.1.3

### Patch Changes

- Updated dependencies
  - @dugstack/drizzle-migrator@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [5bd7ac0]
  - @dugstack/drizzle-migrator@0.2.0
