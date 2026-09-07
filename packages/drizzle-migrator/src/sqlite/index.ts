export * from "../core/index.js";

export function createSqliteAdapter(): never {
  throw new Error("sqlite adapter not implemented in v1");
}
