import { type Options, defineConfig } from "tsup";

const shared: Options = {
  format: ["esm"],
  sourcemap: true,
  target: "es2022",
  platform: "node",
  splitting: false,
  clean: false,
  // tsup auto-externalizes dependencies and peerDependencies but bundles
  // optionalDependencies; the mysql and sqlite drivers are optional and must
  // stay runtime-resolved imports — bundling a CJS driver into the ESM output
  // breaks it with "Dynamic require of \"fs\" is not supported" at first use.
  external: ["better-sqlite3", "mysql2", "mysql2/promise"],
};

export default defineConfig([
  { ...shared, entry: { index: "src/index.ts" }, dts: true, treeshake: true, clean: true },
  {
    ...shared,
    entry: { bin: "src/bin.ts" },
    banner: { js: "#!/usr/bin/env node" },
  },
]);
