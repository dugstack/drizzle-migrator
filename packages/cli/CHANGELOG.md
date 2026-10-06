# @dugstack/drizzle-migrator-cli

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
