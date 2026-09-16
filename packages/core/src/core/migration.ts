export type RunSqlFileRange = {
  from?: number;
  to?: number;
};

export interface MigrationContext<TFiles extends readonly string[]> {
  readonly tx: unknown;
  execute: (sql: string) => Promise<void>;
  runSqlFile: (file: TFiles[number], range?: RunSqlFileRange) => Promise<void>;
  audit: (kind: string, payload?: unknown) => Promise<void>;
}

export type MigrationInput<TFiles extends readonly string[] = readonly string[]> = {
  version: string;
  name: string;
  sqlFiles?: TFiles;
  up: (ctx: MigrationContext<TFiles>) => Promise<void>;
};

export type Migration<TFiles extends readonly string[] = readonly string[]> = {
  readonly version: string;
  readonly name: string;
  readonly sqlFiles: TFiles;
  readonly up: (ctx: MigrationContext<TFiles>) => Promise<void>;
};

export function defineMigration<const TFiles extends readonly string[] = readonly []>(
  migration: MigrationInput<TFiles>,
): Migration<TFiles> {
  return migration as Migration<TFiles>;
}
