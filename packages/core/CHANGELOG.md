# @dugstack/drizzle-migrator

## 0.2.0

### Minor Changes

- 5bd7ac0: Add the SQLite dialect adapter behind `@dugstack/drizzle-migrator/sqlite` (`sqliteDialect`,
  `SqliteDialect`, `createSqliteAdapter`, `SqliteDatabase`, `SqliteTransaction`), built on
  `drizzle-orm/better-sqlite3` (optional peer dependency `better-sqlite3 >=9`).

  Locking uses the database file's single-writer rule: `acquireLock` holds a `BEGIN IMMEDIATE`
  transaction for the run and `releaseLock` commits it, so the whole run (tracking rows included)
  publishes atomically and concurrent migrators serialize with busy/timeout polling.
  `runInTransaction` nests via SAVEPOINTs. Tracking tables use ISO-8601 text timestamps, live at the
  top level of the database file (`config.schema` is validated but otherwise unused), and
  `currentDatabaseName` returns the main database file path for `--confirm-database` matching.
