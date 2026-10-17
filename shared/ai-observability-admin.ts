import type { RunSummary } from "./ai-observability-runs";

/*
 * The wire contract the two #42 pages consume, mirroring the server projections:
 * GET /api/ai-observability/admin/summary (T33, server/src/ai-observability/admin-summary.ts)
 * and GET /api/ai-observability/bots/:botId/exports (T34, .../routes/exports.ts). The server
 * files stay the projections' source of truth; this file is the browser's typed view of the
 * same shapes, and the runtime guards beside each query keep the two honest with each other.
 *
 * Honesty rules inherited from the server side: an upstream-derived count the collection
 * could not answer is explicitly null — an unknown number, never zero in disguise — and every
 * enumerated word (binding states, capabilities, readiness reasons, export states, error
 * codes) is the closed vocabulary the earlier tickets shipped, verbatim.
 */

/** The T13 readiness reasons, verbatim; null when the deployment is ready. */
export type AdminReadinessReason =
  | "disabled"
  | "unconfigured"
  | "capability_missing"
  | "authentication_failure"
  | "unreachable";

/** The binding state vocabulary — the same words the runs pages already speak. */
export type AdminRunState =
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted"
  | "unknown";

/** The capability verdicts of the counted bindings. */
export type AdminCapability = "basic" | "detailed" | "unavailable";

/** The T34 export job states. */
export type AdminExportJobState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AdminBotSummary = Readonly<{
  botId: string;
  runs: Readonly<{
    total: number;
    byState: Readonly<Record<AdminRunState, number>>;
    /** Begun but never reconciled upstream — the "still syncing" evidence. */
    pendingSync: number;
    capabilities: Readonly<Record<AdminCapability, number>>;
    /** Null when collection cannot answer — never a zero in disguise. */
    unboundUpstream: number | null;
    usage: Readonly<{ providerReported: number; unavailable: number }> | null;
    /**
     * R2-46: true when the upstream listing covered only the first window of a
     * larger project — unboundUpstream and usage are then window-bounded lower
     * bounds over what was seen, never the project's exact answer.
     */
    upstreamTruncated: boolean;
  }>;
  experiments: Readonly<{ draft: number; frozen: number }>;
  exports: Readonly<{
    byState: Readonly<Record<AdminExportJobState, number>>;
    /** The most recent failed job's closed-vocabulary code, if any. */
    lastFailedErrorCode: string | null;
  }>;
  collection: Readonly<{ lastCollectedAt: string | null }>;
}>;

export type AdminSummaryResult = Readonly<{
  window: Readonly<{
    from: string | null;
    to: string | null;
    botId: string | null;
  }>;
  collection: Readonly<{
    readiness: Readonly<{
      ready: boolean;
      reason: AdminReadinessReason | null;
    }>;
    dropped: Readonly<{ queueFull: number; notReady: number }>;
  }>;
  bots: readonly AdminBotSummary[];
  botsTruncated: boolean;
}>;

export type ExportJobView = Readonly<{
  jobId: string;
  state: AdminExportJobState;
  /** The deployment's row cap, snapshotted at enqueue time. */
  rowLimit: number;
  /** Rows in the artifact; null until the job completes. */
  rowCount: number | null;
  /** The closed-vocabulary code, exactly when the state is failed. */
  errorCode: string | null;
  /** The redaction policy the job froze under, e.g. "opik-redaction/5" (a string —
   *  it mirrors the server's text column, per the datasets contract's same field). */
  redactionPolicyVersion: string;
  createdAt: string;
  settledAt: string | null;
  /** The projected rows, riding along exactly when the state is completed. */
  artifact?: readonly RunSummary[];
}>;

/**
 * One job as the LIST answers it (R2-40): the poll face, without the artifact inline.
 * The list is what a 5-second poll reads, and a thousand jobs each carrying their rows
 * inline amplified every poll to tens of megabytes — so the list carries the job's facts
 * and, for a completed job, where the product lives: the detail endpoint, which rides
 * the artifact exactly when the state is completed.
 */
export type ExportJobListItem = Readonly<{
  jobId: string;
  state: AdminExportJobState;
  /** The deployment's row cap, snapshotted at enqueue time. */
  rowLimit: number;
  /** Rows in the artifact; null until the job completes. */
  rowCount: number | null;
  /** The closed-vocabulary code, exactly when the state is failed. */
  errorCode: string | null;
  /** The redaction policy the job froze under — mirrors ExportJobView's same field. */
  redactionPolicyVersion: string;
  createdAt: string;
  settledAt: string | null;
  /** Where the artifact rides, exactly when the state is completed: the detail URL. */
  artifactUrl?: string;
}>;

/** The list answer: one page of jobs plus the offset facts the next request needs. */
export type ExportJobsResult = Readonly<{
  jobs: readonly ExportJobListItem[];
  pagination: Readonly<{
    /** Live jobs of this scope, whatever paging did — the poll's "anything new" signal. */
    total: number;
    offset: number;
    limit: number;
    /** The offset of the next page, or null when this page was the last. */
    nextOffset: number | null;
  }>;
}>;
