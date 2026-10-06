#!/usr/bin/env bash

# npm cannot re-stage an existing version. This makes a failed partial release
# safe to retry after any already-staged package has been approved or rejected.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)

# npm stage publish does not rewrite pnpm's workspace: protocol the way
# `pnpm publish` does, so the packed manifest would ship an uninstallable
# dependency spec (as the 0.1.3 CLI release did). Resolve workspace: specs
# against the workspace packages the same way pnpm would: "workspace:^" ->
# "^<version>", "workspace:*" or bare "workspace:" -> the exact version,
# "workspace:^X.Y.Z" -> "^X.Y.Z". The caller restores the manifest from git.
rewrite_workspace_dependencies() {
  REPO_ROOT="$REPO_ROOT" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const packagesDir = path.join(process.env.REPO_ROOT, "packages");
const workspaceVersions = new Map();
for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const manifestPath = path.join(packagesDir, entry.name, "package.json");
  if (!fs.existsSync(manifestPath)) {
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  workspaceVersions.set(manifest.name, manifest.version);
}

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
let rewritten = 0;
for (const field of [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]) {
  const deps = manifest[field];
  if (!deps) {
    continue;
  }
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== "string" || !spec.startsWith("workspace:")) {
      continue;
    }
    const version = workspaceVersions.get(name);
    if (version === undefined) {
      throw new Error(`workspace dependency ${name} not found under packages/`);
    }
    const prefix = spec.slice("workspace:".length);
    deps[name] =
      prefix === "*" || prefix === ""
        ? version
        : prefix === "^" || prefix === "~"
          ? `${prefix}${version}`
          : prefix;
    rewritten += 1;
  }
}

fs.writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`rewrote ${rewritten} workspace dependency spec(s) in package.json`);
NODE
}

for package_dir in packages/core packages/cli; do
  package_name=$(node -p "require('./$package_dir/package.json').name")
  package_version=$(node -p "require('./$package_dir/package.json').version")

  if npm view "$package_name@$package_version" version >/dev/null 2>&1; then
    echo "Skipping published $package_name@$package_version"
    continue
  fi

  (
    cd "$package_dir"
    rewrite_workspace_dependencies
    trap 'git checkout -- package.json' EXIT
    npm stage publish --access public --provenance --tag latest
  )
done
