import { type Options, defineConfig } from "tsup";

const shared: Options = {
  format: ["esm"],
  dts: true,
  sourcemap: true,
  target: "es2022",
  platform: "node",
  splitting: false,
  clean: false,
  treeshake: true,
};

export default defineConfig([
  { ...shared, entry: { "core/index": "src/core/index.ts" }, clean: true },
  { ...shared, entry: { "pg/index": "src/pg/index.ts" } },
  { ...shared, entry: { "mysql/index": "src/mysql/index.ts" } },
  { ...shared, entry: { "sqlite/index": "src/sqlite/index.ts" } },
]);
