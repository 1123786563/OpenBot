import { Hono } from "hono";
import { DEV_CSP_ALLOW_LISTED, STATIC_CSP } from "./preview";

/**
 * The workshop's ANONYMOUS surface: what a share token reaches (B14's half of the door).
 *
 * B14's tokens mint a scoped actor; this file is where that actor meets HTTP without a
 * session. This batch ships the skeleton — the routes exist, the CSP contract is pinned, and
 * the handlers deliberately answer "not yet" (503 with a sentence) so B14's wiring lands into
 * a shape that already holds its security posture, not into a void it has to invent.
 *
 * NOTHING HERE BYPASSES OWNERSHIP BY ACCIDENT: the resolve-actor step (B14) is the only door
 * in, and it is not mounted yet — see sharing.ts's "the ONLY read path that bypasses
 * canUseBot" contract, which these routes are the HTTP half of.
 */
export function createWorkshopPublicRoutes(): Hono {
  const app = new Hono();

  app.get("/:channelId/public/preview/*", (context) => {
    // B14 wires this: token → scoped actor → the same static road the owner sees, CSP and all.
    return context.json(
      { error: "Public previews arrive with the share batch (B14)." },
      503,
    );
  });

  app.get("/:channelId/public/artifacts/:artifactId", (context) => {
    // B14 wires this: the signed artifact URL's verifier and the download it unlocks.
    return context.json(
      { error: "Public artifact downloads arrive with the share batch (B14)." },
      503,
    );
  });

  return app;
}

/** Re-exported for B14's wiring: both roads' CSP, one source of truth. */
export { STATIC_CSP, DEV_CSP_ALLOW_LISTED };
