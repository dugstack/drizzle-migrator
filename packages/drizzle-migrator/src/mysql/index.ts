export * from "../core/index.js";

export function createMysqlAdapter(): never {
  throw new Error("mysql adapter not implemented in v1");
}
