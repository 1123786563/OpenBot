import { Hono, type MiddlewareHandler } from "hono";
import { type AppVariables, requireAdmin } from "../auth/guards";
import type { OpenMuseFileStore } from "../openmuse-files/store";
import type { OpenMuseNotificationStore } from "../openmuse-notifications/store";
import type { OpenMuseFileBytePurgeReport } from "./purge";
import type { OpenMuseRelationalPurgeOutcome } from "./purge-relational";
import {
  sanitizeLastError,
  type OpenMuseDeletionCleanupView,
} from "./retention";
import { OpenMusePurgeRefusedError } from "./store";
import type {
  OpenMuseAccountDeletionStore,
  OpenMuseDeletionResourceRows,
  StoredOpenMuseAccountDeletion,
} from "./store";

/*
 * D05 (§9 restoration): within 30 days, an administrator restore returns the
 * recoverable set READ-ONLY. The restore is a FENCE LIFT + status
 * resurrection: the marker's phase flips `fenced` → `restored` (the fence
 * re-admits; cancelled Tasks stay terminal, awaiting→cancelled Reviewed
 * actions stay cancelled — nothing resumes), the §9 module hooks
 * (`restoreOwner`, the seams their owning tickets tested) re-clear their own
 * disables, the connection rows stay revoked (external credentials are NOT
 * restorable — recorded in the report, not repaired), and the manifest rows
 * remain untouched (retention is D09's). Past `restoreUntil` the answer is
 * 410.
 */

/** §9: the restoration window, counted from the marker's disabledAt. */
export const OPENMUSE_RESTORE_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * The restore report's three classes (§9): what is live again, what returns
 * read-only, and what is explicitly not restorable. The kinds are D04's
 * manifest vocabulary, so the report and the manifest name the same rows.
 */
export type OpenMuseRestoreReport = {
  userId: string;
  phase: "restored";
  disabledAt: string;
  restoreUntil: string | null;
  /** Bot profile, Channel/Thread history, Files/versions, Goals, Ideas, Memory, notifications — the fence lift is their restoration. */
  liveAgain: string[];
  /** Task/steps/evidence and Reviewed actions — history, never resumed. */
  readOnly: string[];
  /** External credentials: the connection rows stay revoked. */
  notRestorable: string[];
};

/** What the restore decided — the route's whole truth. */
export type OpenMuseDeletionRestoreOutcome =
  | { status: 404 }
  | { status: 410; restoreUntil: string }
  | { status: 200; report: OpenMuseRestoreReport };

export type OpenMuseDeletionRestore = (
  userId: string,
) => Promise<OpenMuseDeletionRestoreOutcome>;

function restoreReport(
  marker: StoredOpenMuseAccountDeletion,
  filesPurged = false,
): OpenMuseRestoreReport {
  /*
   * D06 interplay: liveAgain promises "Files/versions — the fence lift is
   * their restoration", which D05's contract holds only "provided D06
   * hasn't purged". Once a manifest file row is `deleted` its byte objects
   * are gone for good, so the kind answers bytes-unavailable instead.
   */
  return {
    userId: marker.userId,
    phase: "restored",
    disabledAt: marker.disabledAt.toISOString(),
    restoreUntil: marker.restoreUntil
      ? marker.restoreUntil.toISOString()
      : null,
    liveAgain: [
      "openmuse-bot",
      "openmuse-channel",
      ...(filesPurged ? [] : ["openmuse-file"]),
      "openmuse-goal",
      "openmuse-idea",
      "openmuse-memory",
      "openmuse-notification",
    ],
    readOnly: ["openmuse-task", "openmuse-reviewed-action"],
    notRestorable: [
      "openmuse-google-connection",
      "openmuse-google-calendar-connection",
      ...(filesPurged ? ["openmuse-file"] : []),
    ],
  };
}

/**
 * The §9 restoration the admin route runs. The clock is injectable — the
 * 30-day window is decided by time, not by arrival order. The hooks are
 * EMIT-ONLY calls into the modules' own tested `restoreOwner` seams; modules
 * without a wired hook need none (the fence lift is their restoration).
 */
export function createOpenMuseDeletionRestore(deps: {
  marker: Pick<OpenMuseAccountDeletionStore, "get" | "restore">;
  now?: () => Date;
  /** openmuse-files/store.ts `restoreOwner`: clears the owner-disable marker. */
  files?: Pick<OpenMuseFileStore, "restoreOwner">;
  /** openmuse-notifications/store.ts `restoreOwner`: the rows seam's clear. */
  notifications?: Pick<OpenMuseNotificationStore, "restoreOwner">;
  /**
   * D06: the manifest rows. Wired, the report consults them — a `deleted`
   * file row means its bytes were purged, so files answer
   * bytes-unavailable instead of live-again. Unwired, D05's answer stands.
   */
  manifestRows?: Pick<OpenMuseDeletionResourceRows, "listResources">;
}): OpenMuseDeletionRestore {
  const now = deps.now ?? (() => new Date());
  // ANY deleted file row already lost byte objects, so "files come back"
  // would be a lie for them — the report says notRestorable from the first.
  const filesPurged = async (userId: string): Promise<boolean> => {
    if (!deps.manifestRows) return false;
    const fileRows = (await deps.manifestRows.listResources(userId)).filter(
      (row) => row.kind === "openmuse-file",
    );
    return fileRows.some((row) => row.state === "deleted");
  };
  return async function restoreOwner(userId) {
    const marker = await deps.marker.get(userId);
    // No marker: this account was never deleted (or already fully purged).
    if (!marker) return { status: 404 } as const;
    /*
     * D08 interplay: a completed marker is a purge that emptied everything
     * §9 could restore — liveAgain would be a lie from any calendar. The
     * answer is 410 for good, the same shape the elapsed window answers.
     */
    if (marker.phase === "completed") {
      const deadline =
        marker.restoreUntil ??
        new Date(
          marker.disabledAt.getTime() + OPENMUSE_RESTORE_WINDOW_DAYS * DAY_MS,
        );
      return { status: 410, restoreUntil: deadline.toISOString() } as const;
    }
    // An already-restored marker answers its report again — the window
    // governs the restoration act, not the answer about a completed one.
    if (marker.phase === "restored") {
      await deps.files?.restoreOwner(userId);
      await deps.notifications?.restoreOwner(userId);
      return {
        status: 200,
        report: restoreReport(marker, await filesPurged(userId)),
      } as const;
    }
    const deadline =
      marker.restoreUntil ??
      new Date(
        marker.disabledAt.getTime() + OPENMUSE_RESTORE_WINDOW_DAYS * DAY_MS,
      );
    if (now().getTime() > deadline.getTime()) {
      return { status: 410, restoreUntil: deadline.toISOString() } as const;
    }
    // The flip first — the fence re-admits the moment the phase turns — then
    // the idempotent module hooks. A repeat of either changes nothing, and
    // nothing here writes a Task or Monitor: cancelled work stays stopped.
    const stored = (await deps.marker.restore(userId, deadline)) ?? marker;
    await deps.files?.restoreOwner(userId);
    await deps.notifications?.restoreOwner(userId);
    return {
      status: 200,
      report: restoreReport(stored, await filesPurged(userId)),
    } as const;
  };
}

/**
 * G06's display guard on the purge reports' retryable reasons: the same
 * lastError the cleanup view sanitizes — a recorded reason may quote the
 * credential it failed on, and these admin answers are exits like that one,
 * never the surface a raw reason escapes through.
 */
function sanitized<T extends { retryable: Array<{ lastError: string }> }>(
  report: T,
): T {
  return {
    ...report,
    retryable: report.retryable.map((row) => ({
      ...row,
      lastError: sanitizeLastError(row.lastError) ?? row.lastError,
    })),
  };
}

/**
 * `/api/admin/openmuse-deletion`: the D05 restore route, administrator-only
 * the I09 way — `requireUser` first, `requireAdmin` inside the factory
 * (openmuse-template-routes.ts's gate). Mounted beside nothing else; the
 * marker store's own seam is the only dependency the route needs.
 */
export function createOpenMuseDeletionAdminRoutes(deps: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  restore: OpenMuseDeletionRestore;
  /**
   * D06 (§9): the file byte purge — the manifest's file rows drive byte
   * deletion before the metadata rows are removed, a refusal lands its row
   * retryable, and the route answers the pass's report. Absent leaves the
   * restore-only surface.
   */
  purge?: (userId: string) => Promise<OpenMuseFileBytePurgeReport>;
  /**
   * D08 (§9): the final relational purge — the manifest's remaining kinds
   * drive removal of the relational rows once D06's bytes and D07's grants
   * are terminal (else the route answers 409 naming what still owes), and
   * completion empties the manifest and completes the marker. Absent leaves
   * the D06 purge surface as it was.
   */
  purgeRelational?: (userId: string) => Promise<OpenMuseRelationalPurgeOutcome>;
  /**
   * D09 (§9): the cleanup visibility — the deployment-wide cleanup state
   * (unresolved manifest rows with sanitized reasons, retryable counts,
   * retention flags; a completed deletion answers only its audit summary).
   * Absent leaves the purge surface as it was.
   */
  cleanupView?: () => Promise<OpenMuseDeletionCleanupView>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });

  routes.post("/:userId/restore", async (context) => {
    const outcome = await deps.restore(context.req.param("userId"));
    if (outcome.status === 404) {
      return context.json(
        { error: "No deletion marker exists for this account." },
        404,
      );
    }
    if (outcome.status === 410) {
      return context.json(
        {
          error: "The 30-day restoration window has elapsed.",
          restoreUntil: outcome.restoreUntil,
        },
        410,
      );
    }
    return context.json({ restore: outcome.report });
  });

  routes.post("/:userId/purge", async (context) => {
    if (!deps.purge) {
      return context.json({ error: "File byte purge is not wired." }, 404);
    }
    try {
      return context.json({
        purge: sanitized(await deps.purge(context.req.param("userId"))),
      });
    } catch (error) {
      // §9's phase gate: a marker that is not still fenced names a live
      // account — the refusal is a state conflict, not a server failure.
      if (error instanceof OpenMusePurgeRefusedError) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  routes.post("/:userId/purge-relational", async (context) => {
    if (!deps.purgeRelational) {
      return context.json({ error: "Relational purge is not wired." }, 404);
    }
    const outcome = await deps.purgeRelational(context.req.param("userId"));
    if (outcome.status === 409) {
      return context.json(
        {
          error:
            outcome.refused ??
            "External cleanup is unfinished; the manifest still owes the blocked rows.",
          ...(outcome.refused ? {} : { blocked: outcome.blocked }),
        },
        409,
      );
    }
    return context.json({ purge: sanitized(outcome.report) });
  });

  /*
   * D09 (§9): the operator's eye on cleanup — one read-only walk of every
   * marker's state. Unresolved rows are listed (kind, safe id, sanitized
   * reason, at) and never cleared by it; a completed deletion answers only
   * its non-personal audit summary.
   */
  routes.get("/cleanup", async (context) => {
    if (!deps.cleanupView) {
      return context.json({ error: "Cleanup visibility is not wired." }, 404);
    }
    return context.json({ cleanup: await deps.cleanupView() });
  });

  return routes;
}
