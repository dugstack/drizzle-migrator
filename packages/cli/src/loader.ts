import { createJiti } from "jiti";

export type ModuleLoader = (absolutePath: string) => Promise<unknown>;

/**
 * TypeScript-aware module loader for user config files and migration entries.
 * Caches are off: the CLI is a one-shot process, and tests must not leak modules
 * between fixture projects.
 */
export function createModuleLoader(anchorPath: string): ModuleLoader {
  const jiti = createJiti(anchorPath, {
    interopDefault: false,
    moduleCache: false,
    fsCache: false,
  });
  return (absolutePath) => jiti.import(absolutePath);
}

/**
 * Unwraps the default export of a module loaded through jiti. Transpiled ESM
 * carries the `__esModule` marker; plain CJS and JSON come through raw. When a
 * module has no default export, the namespace itself is returned (so named
 * exports such as `out` stay readable).
 */
export function unwrapDefaultExport(mod: unknown): unknown {
  if (
    typeof mod === "object" &&
    mod !== null &&
    (mod as { __esModule?: unknown }).__esModule === true &&
    "default" in mod
  ) {
    const value = (mod as { default?: unknown }).default;
    return value !== undefined && value !== null ? value : mod;
  }
  return mod;
}
