#!/usr/bin/env bash

# npm cannot re-stage an existing version. This makes a failed partial release
# safe to retry after any already-staged package has been approved or rejected.
set -euo pipefail

for package_dir in packages/core packages/cli; do
  package_name=$(node -p "require('./$package_dir/package.json').name")
  package_version=$(node -p "require('./$package_dir/package.json').version")

  if npm view "$package_name@$package_version" version >/dev/null 2>&1; then
    echo "Skipping published $package_name@$package_version"
    continue
  fi

  (
    cd "$package_dir"
    npm stage publish --access public --provenance --tag alpha
  )
done
