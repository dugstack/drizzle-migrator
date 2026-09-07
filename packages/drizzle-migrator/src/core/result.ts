export type MigrationOrigin = "executed" | "adopted";

export type RunMigrationsResult = {
  applied: string[];
  skipped: string[];
  dryRun: string[];
};

export type AdoptResult = {
  adopted: string[];
  notAdopted: string[];
};

export type StatusReport = {
  currentVersion: string | null;
  applied: {
    version: string;
    name: string;
    origin: MigrationOrigin;
    appliedAt: string;
  }[];
  pending: { version: string; name: string }[];
  recentLogs: { at: string; kind: string; version: string | null; detail: string | null }[];
};
