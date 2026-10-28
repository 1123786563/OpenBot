import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/public";
import type { OpenMuseDeletionManifest } from "./manifest";
import { sanitizeLastError } from "./retention";
import type {
  OpenMuseAccountDeletionStore,
  StoredOpenMuseAccountDeletion,
} from "./store";

/**
 * `/openmuse-account` (mounted under `/api/mobile` by the app seam): the one
 * route of D01. `POST /delete` writes the §9 marker — insert-once, the first
 * act of deletion, BEFORE any revocation work — and answers with it. A repeat
 * is idempotent: the same marker, the same disabledAt, still 200. Revocation
 * itself is D02/D03's; this route fences and nothing more.
 */

function deletionDto(marker: StoredOpenMuseAccountDeletion) {
  return {
    userId: marker.userId,
    disabledAt: marker.disabledAt.toISOString(),
    phase: marker.phase,
    restoreUntil: marker.restoreUntil
      ? marker.restoreUntil.toISOString()
      : null,
  };
}

export function createOpenMuseAccountDeletionRoutes(deps: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  store: OpenMuseAccountDeletionStore;
  /**
   * D02 (§9): the work shutdown run after the marker — cancels Tasks and
   * Monitors, cancels awaiting Reviewed actions, records the transitions.
   * Absent leaves D01's fence-only behaviour (the fence is not
   * cleanup-dependent).
   *
   * WIRING STATUS (production): index.ts wires shutdownOwnerWork /
   * revokeExternalAccess / buildManifest / revokeSessions /
   * noteBackupRetention through app.ts's openMuseSeams since the
   * ocr-ob-certify repair (findings 15/16/19) — a production delete runs the
   * full §9 order behind the marker, not fence-only.
   */
  shutdownOwnerWork?: (userId: string) => Promise<unknown>;
  /**
   * D03 (§9): the external access revocation run after the shutdown —
   * withdraws every Google connection seat at the vendor best-effort (a
   * refusal records retryable and never blocks this route) and lands the
   * rows revoked, with the evidence entries in the marker's resources.
   */
  revokeExternalAccess?: (userId: string) => Promise<unknown>;
  /**
   * D04 (§9): the resource manifest built after the revocation — every owner
   * resource enumerated and recorded BEFORE any metadata removal (the
   * cleanup that follows is D06/D07/D08's). The route answers with it.
   */
  buildManifest?: (userId: string) => Promise<OpenMuseDeletionManifest>;
  /**
   * §9 hardening, run FIRST behind the marker: the deleting owner's auth
   * sessions are revoked with it, so a still-valid session cannot keep
   * reaching the seams the /api/mobile fence does not cover (channels, the
   * computer stream, copilot). Absent leaves the sessions to expire on
   * their own clock.
   */
  revokeSessions?: (userId: string) => Promise<unknown>;
  /**
   * D09 (§9): the backup-retention bookkeeping — one evidence entry on the
   * marker recording that the deployment's backup window covers this
   * deletion (covered-at / retention-days / expires). Absent leaves the
   * policy seam unwired (the pure readers still answer for the cleanup view).
   */
  noteBackupRetention?: (userId: string) => Promise<string | null>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);

  routes.post("/delete", async (context) => {
    const marker = await deps.store.delete(context.var.actor.id);
    // After the marker, by §9's ordering: the fence is live the moment the
    // row exists, and the shutdown/revocation/manifest behind it are
    // convergence work. Each step's outcome is answered by name: a failed
    // step must not turn the whole answer into an opaque 500 that hides
    // which progress already landed (every step is idempotent, so a retry
    // re-runs exactly the steps recorded failed).
    const steps: Record<string, string> = {};
    let manifest: OpenMuseDeletionManifest | undefined;
    const run = async (
      name: string,
      step: () => Promise<unknown>,
    ): Promise<void> => {
      try {
        await step();
        steps[name] = "ok";
      } catch (error) {
        // G06's display guard, the same one the manifest/cleanup/restore
        // exits run: a step's failure may quote the credential it failed on
        // (a vendor refusal, a DB driver's connect string), and this answer
        // goes to the deleting user, not an operator.
        steps[name] = `failed: ${
          sanitizeLastError(
            error instanceof Error ? error.message : String(error),
          ) ?? "unprintable failure"
        }`;
      }
    };
    // Sessions first: the marker fences /api/mobile, but the owner's other
    // seams (channels, the computer stream, copilot) read no marker — the
    // session dying with the marker is what closes that exposure. The step
    // is named only where the seam is wired, so an unwired deployment's
    // answer keeps exactly the steps it can act on.
    if (deps.revokeSessions) {
      const revokeSessions = deps.revokeSessions;
      await run("sessions", () => revokeSessions(context.var.actor.id));
    }
    /*
     * Round 6 (M18): the three tail steps follow sessions' own rule — named
     * only where the seam is wired. A Promise.resolve() fallback reported
     * "ok" for work an unwired deployment never ran (and "manifest: ok" with
     * no manifest field in the answer at all), so a caller or a monitor
     * could not tell "executed" from "not wired". Every step is idempotent,
     * so a partial wiring's answer still names exactly what can act.
     */
    if (deps.shutdownOwnerWork) {
      const shutdownOwnerWork = deps.shutdownOwnerWork;
      await run("shutdown", () => shutdownOwnerWork(context.var.actor.id));
    }
    // §9 D03: the vendor disconnect runs behind the work shutdown and can
    // never fail this answer — a vendor refusal is bookkept retryable.
    if (deps.revokeExternalAccess) {
      const revokeExternalAccess = deps.revokeExternalAccess;
      await run("revoke", () => revokeExternalAccess(context.var.actor.id));
    }
    // §9 D04: with the work shut and the seats revoked, every remaining
    // owner resource is recorded BEFORE any metadata removal — the manifest
    // is what the later cleanup (D06+) works from and this route answers.
    if (deps.buildManifest) {
      const buildManifest = deps.buildManifest;
      await run("manifest", async () => {
        manifest = await buildManifest(context.var.actor.id);
      });
    }
    // D09: the retention bookkeeping rides the same answer — the marker's
    // evidence names when the deployment's backups may still carry the
    // deleted bytes past the restore window, which the cleanup view reads.
    if (deps.noteBackupRetention) {
      const noteBackupRetention = deps.noteBackupRetention;
      await run("backup-retention", () =>
        noteBackupRetention(context.var.actor.id),
      );
    }
    return context.json({
      deletion: deletionDto(marker),
      steps,
      ...(manifest ? { manifest } : {}),
    });
  });

  return routes;
}
