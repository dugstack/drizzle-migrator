# @dugstack/drizzle-migrator

## 0.3.0

### Minor Changes

- Ship the MySQL dialect adapter. `@dugstack/drizzle-migrator/mysql` exports `mysqlDialect` /
  `MysqlDialect` (plus `createMysqlAdapter`, `MysqlDatabase`, `MysqlTransaction`) replacing the
  v1 stub. Locking uses session-scoped named advisory locks (`GET_LOCK`/`RELEASE_LOCK`) polled
  against `waitTimeoutMs`/`retryIntervalMs`; tracking tables bootstrap into the connected database
  with a drift assertion, mirroring the pg adapter; each migration runs in an InnoDB transaction.
  Requires `mysql2` (optional peer dependency) and MySQL 8.0+. Consumers must pass drizzle over a
  single `mysql2` Connection — never a shared Pool — and should note MySQL DDL implicitly commits,
  so DDL-bearing migrations are not atomic; the audit trail is the reconstruction source.

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
