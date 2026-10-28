import { getLogger } from "../../../shared/logger";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";

const log = getLogger("server");

/**
 * The stable code every fenced answer carries, so a client can tell "this
 * account is deleted" apart from any other 403 it may meet under /api/mobile.
 */
export const OPENMUSE_ACCOUNT_DISABLED_CODE = "openmuse_account_disabled";

/**
 * The §9 fence (D01): while a user carries the account-deletion marker, every
 * new authenticated request on the seams D01 owns — the /api/mobile prefix,
 * the mobile-bff family and every openmuse-* sub-app mount inside it —
 * refuses with 403 and {@link OPENMUSE_ACCOUNT_DISABLED_CODE}.
 *
 * MOUNT BOUNDARY RECORDED: one shared guard at the `/api/mobile/*` prefix,
 * registered in app.ts BEFORE the mobile mounts (and after the delete route,
 * so a repeat delete still answers). The computer and copilot seams are
 * D02/D03's follow-ups, not fenced here.
 *
 * EXPOSURE CLOSED (ocr-ob-certify finding 16): those seams still consult no
 * marker — but the delete route now revokes the owner's auth sessions with
 * the marker (routes.ts's sessions step, wired in index.ts), so a deleted
 * owner's session dies with the marker instead of keeping /api/channels, the
 * computer screen stream and copilot reachable until its own expiry. A fence
 * per seam remains the belt to this braces; add one before GA if a deployment
 * ever needs sign-in-while-fenced to stay useless on those seams too.
 *
 * The fence runs the same `requireUser` its families run, composed the way
 * the enterprise gate composes it: an unauthenticated request keeps the
 * guard's own 401 (it precedes the fence's 403), and the family's guard runs
 * again behind the fence — a second session read, the price of refusing
 * before rather than instead of the families.
 */
export function openMuseAccountFence(deps: {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  isDisabled: (userId: string) => Promise<boolean>;
}): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    let fenced: Response | undefined;
    let fenceFailed = false;
    const authenticated = await deps.requireUser(context, async () => {
      try {
        if (await deps.isDisabled(context.var.actor.id)) {
          fenced = context.json(
            {
              error: "This OpenMuse account has been deleted.",
              code: OPENMUSE_ACCOUNT_DISABLED_CODE,
            },
            403,
          );
        }
      } catch (error) {
        // A marker read that fails must fail closed as its own sentence, not
        // as a bodyless 500 — the fence is what stands between /api/mobile
        // and a deleted owner's data.
        fenceFailed = true;
        log.error(
          {
            type: "openmuse-account-fence-failed",
            error: error instanceof Error ? error.message : String(error),
          },
          "openmuse-account-fence-failed",
        );
      }
    });
    // requireUser answered on its own: not signed in, or no identity provider.
    if (authenticated instanceof Response) return authenticated;
    if (fenceFailed) {
      return context.json(
        {
          error: "This account check is unavailable right now. Try again.",
          code: OPENMUSE_ACCOUNT_DISABLED_CODE,
        },
        503,
      );
    }
    if (fenced) return fenced;
    return next();
  };
}
