import { type Options, defineConfig } from "tsup";

const shared: Options = {
  format: ["esm"],
  sourcemap: true,
  target: "es2022",
  platform: "node",
  splitting: false,
  clean: false,
};

export default defineConfig([
  { ...shared, entry: { index: "src/index.ts" }, dts: true, treeshake: true, clean: true },
  {
    ...shared,
    entry: { bin: "src/bin.ts" },
    banner: { js: "#!/usr/bin/env node" },
  },
]);
