import { OPENMUSE_RESTORE_WINDOW_DAYS } from "./restore";
import type {
  OpenMuseAccountDeletionStore,
  OpenMuseDeletionResourceRows,
  StoredOpenMuseAccountDeletion,
  StoredOpenMuseDeletionResource,
} from "./store";

/*
 * D09 (§9 retention/ops): backups containing deleted personal bytes expire
 * within the configured retention. HONEST SCOPING: the backup system itself
 * is deployment infrastructure this API does not own — what §9 gets here is
 * the POLICY-LEVEL ENFORCEMENT POINT (retentionElapsed, the pure seam the
 * window is decided by, and noteBackupRetention, the bookkeeping row that
 * records when a deployment's backup window covers a deletion) plus the
 * OPERATOR VISIBILITY (the cleanup view the admin route answers). Until
 * retention elapses the manifest persists — nothing here archives or clears
 * anything, and unresolved rows are never silently cleared.
 */

const DAY_MS = 86_400_000;

/** One §9 bound: the env if it holds a usable number, the contract's default if not. */
function bound(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** §9: the deployment retention window, counted past the restore window. */
export const OPENMUSE_BACKUP_RETENTION_DAYS_DEFAULT = 30;

/** The retention window a deployment sizes with OPENMUSE_BACKUP_RETENTION_DAYS. */
export function backupRetentionDays(): number {
  return bound(
    "OPENMUSE_BACKUP_RETENTION_DAYS",
    OPENMUSE_BACKUP_RETENTION_DAYS_DEFAULT,
  );
}

/**
 * The moment a marker's backups have aged out at: the restore window D05
 * pinned (restoreUntil, or its disabledAt + 30-day fallback) plus the
 * deployment retention window.
 */
export function retentionDeadline(
  marker: Pick<StoredOpenMuseAccountDeletion, "disabledAt" | "restoreUntil">,
  retentionDays = backupRetentionDays(),
): Date {
  const restoreUntil =
    marker.restoreUntil ??
    new Date(
      marker.disabledAt.getTime() + OPENMUSE_RESTORE_WINDOW_DAYS * DAY_MS,
    );
  return new Date(restoreUntil.getTime() + retentionDays * DAY_MS);
}

/**
 * The §9 policy seam (pure, clock-injected): has the backup retention
 * elapsed for this marker — false while the manifest persists, true once the
 * deletion is eligible for its final archive. The clock decides, never the
 * arrival order.
 */
export function retentionElapsed(
  marker: Pick<StoredOpenMuseAccountDeletion, "disabledAt" | "restoreUntil">,
  now: Date,
  retentionDays = backupRetentionDays(),
): boolean {
  return now.getTime() > retentionDeadline(marker, retentionDays).getTime();
}

/*
 * G06's display guard, server-side: an error message may quote the
 * credential it failed on, and operator signals carry no token (§4) — so a
 * token-shaped reason is replaced wholesale with the fixed sentence below,
 * and a plain one passes through truncated.
 */
const TOKEN_SHAPED = [
  /ya29\.[A-Za-z0-9_-]+/,
  /1\/\/0[A-Za-z0-9_-]+/,
  /[A-Za-z0-9+/=]{40,}/,
  /\bbearer\s/i,
];

/** The fixed sentence a token-shaped reason is replaced with. */
export const OPENMUSE_REDACTED_LAST_ERROR =
  "redacted: the recorded reason may quote a credential";

/** The visibility sentence limit — plain errors pass through, truncated. */
const LAST_ERROR_MAX = 120;

/** The reason an operator may read: sanitized, or absent when none was recorded. */
export function sanitizeLastError(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const sentence = raw.trim();
  if (TOKEN_SHAPED.some((shape) => shape.test(sentence)))
    return OPENMUSE_REDACTED_LAST_ERROR;
  return sentence.slice(0, LAST_ERROR_MAX);
}

export function createOpenMuseBackupRetention(deps: {
  marker: Pick<OpenMuseAccountDeletionStore, "get">;
  /**
   * The marker's bookkeeping row seam — recordDeletionResources in
   * production, the same append-only evidence array D02/D03 wrote.
   */
  record: (userId: string, entries: string[]) => Promise<void>;
  now?: () => Date;
  retentionDays?: number;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    /**
     * The §9 enforcement point: notes ON THE MARKER that a deployment's
     * backup window covers this deletion — covered now, expiring at the
     * retention deadline the pure seam consults. Honest by construction:
     * the row records the policy fact; it never claims the backups are
     * gone. Answers the entry it recorded, or null when no marker exists
     * (nothing covers a deletion that never happened).
     */
    async noteBackupRetention(userId: string): Promise<string | null> {
      const marker = await deps.marker.get(userId);
      if (!marker) return null;
      const retentionDays = deps.retentionDays ?? backupRetentionDays();
      const entry = [
        "openmuse-backup-retention",
        userId,
        `covered-at:${now().toISOString()}`,
        `retention-days:${retentionDays}`,
        `expires:${retentionDeadline(marker, retentionDays).toISOString()}`,
      ].join(":");
      await deps.record(userId, [entry]);
      return entry;
    },
  };
}

/** One unresolved row as the operator reads it: kind, safe id, state, reason, at — never the byte-store key, never bytes. */
export type OpenMuseDeletionCleanupRow = {
  kind: string;
  id: string;
  state: Exclude<StoredOpenMuseDeletionResource["state"], "deleted">;
  lastError?: string;
  at: string;
};

/**
 * One marker's cleanup state: the non-personal audit facts every phase
 * answers with, plus the unresolved rows while anything is still owed.
 */
export type OpenMuseDeletionCleanupMarker = {
  userId: string;
  disabledAt: string;
  phase: StoredOpenMuseAccountDeletion["phase"];
  restoreUntil: string | null;
  /** §9 retention: past it the marker's backups have aged out; the manifest stays until the operator archives. */
  retentionElapsed: boolean;
  /** The retryable_error rows — the operator's retry queue. */
  retryable: number;
  unresolved: OpenMuseDeletionCleanupRow[];
};

/** The deployment-wide cleanup state the admin route answers. */
export type OpenMuseDeletionCleanupView = {
  retentionDays: number;
  markers: OpenMuseDeletionCleanupMarker[];
};

type UnresolvedResource = StoredOpenMuseDeletionResource & {
  state: Exclude<StoredOpenMuseDeletionResource["state"], "deleted">;
};

export function createOpenMuseDeletionCleanupView(deps: {
  markers: Pick<OpenMuseAccountDeletionStore, "list">;
  rows: Pick<OpenMuseDeletionResourceRows, "listResources">;
  now?: () => Date;
  retentionDays?: number;
}): () => Promise<OpenMuseDeletionCleanupView> {
  const now = deps.now ?? (() => new Date());
  return async () => {
    const retentionDays = deps.retentionDays ?? backupRetentionDays();
    const at = now();
    const markers = await Promise.all(
      (await deps.markers.list()).map(async (marker) => {
        const unresolved = (await deps.rows.listResources(marker.userId))
          .filter((row): row is UnresolvedResource => row.state !== "deleted")
          .map((row) => {
            const lastError = sanitizeLastError(row.lastError);
            return {
              kind: row.kind,
              id: row.id,
              state: row.state,
              ...(lastError !== undefined ? { lastError } : {}),
              at: row.updatedAt.toISOString(),
            };
          });
        return {
          userId: marker.userId,
          disabledAt: marker.disabledAt.toISOString(),
          phase: marker.phase,
          restoreUntil: marker.restoreUntil?.toISOString() ?? null,
          retentionElapsed: retentionElapsed(marker, at, retentionDays),
          retryable: unresolved.filter((row) => row.state === "retryable_error")
            .length,
          unresolved,
        };
      }),
    );
    return { retentionDays, markers };
  };
}
