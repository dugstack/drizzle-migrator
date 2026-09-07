export type EngineAuditEventKind =
  | "cli.command"
  | "lock.acquired"
  | "lock.waiting"
  | "lock.released"
  | "lock.timeout"
  | "bootstrap.completed"
  | "run.started"
  | "run.applied"
  | "run.failed"
  | "run.adopted"
  | "dryrun.completed";

export type AuditLogEntry = {
  id?: string;
  at?: string;
  kind: string;
  version?: string | null;
  runId?: string | null;
  payload?: unknown;
  detail?: string | null;
};

export type RecentLogRow = {
  at: string;
  kind: string;
  version: string | null;
  detail: string | null;
};
