import type { OpenMuseGoogleOAuth } from "../openmuse-connectors/google-oauth";

/**
 * What D03's revocation landed, by connection row id — the report shape the
 * delete route's caller (and D04's manifest, later) reads.
 */
export type OpenMuseExternalAccessRevocationReport = {
  connectionsRevoked: string[];
  connectionsRetryable: string[];
};

/**
 * D03's §9 external access revocation, run by the delete route after D02's
 * shutdown: every Google connection seat the owner holds is withdrawn at the
 * vendor BEST-EFFORT — one alias's vendor failure records a retryable entry
 * and the next seat proceeds — and the local rows land revoked. The entries
 * land in the marker's resources (bookkeeping only, D04's manifest
 * enumerates from there). The revocation never blocks the delete route on a
 * vendor refusal: the marker is already on and the fence already refuses
 * everything the revoked seats would open.
 */
export function createOpenMuseExternalAccessRevoker(deps: {
  /** The revoke-connections seam openmuse-connectors emits for D03. */
  connectors: Pick<OpenMuseGoogleOAuth, "revokeOwner">;
  /** The marker's bookkeeping seam; absent in tests that pin the rest. */
  record?: (ownerUserId: string, entries: string[]) => Promise<unknown>;
}) {
  return async function revokeExternalAccess(
    userId: string,
  ): Promise<OpenMuseExternalAccessRevocationReport> {
    const outcomes = await deps.connectors.revokeOwner(userId);
    const entries = outcomes.map((outcome) => {
      return `${outcome.kind}:${outcome.id}:${outcome.outcome}`;
    });
    if (entries.length > 0 && deps.record) {
      await deps.record(userId, entries);
    }
    return {
      connectionsRevoked: outcomes
        .filter((outcome) => outcome.outcome === "revoked")
        .map((outcome) => outcome.id),
      connectionsRetryable: outcomes
        .filter((outcome) => outcome.outcome === "retryable")
        .map((outcome) => outcome.id),
    };
  };
}
