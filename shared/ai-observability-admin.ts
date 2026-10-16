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
  redactionPolicyVersion: number;
  createdAt: string;
  settledAt: string | null;
  /** The projected rows, riding along exactly when the state is completed. */
  artifact?: readonly RunSummary[];
}>;
