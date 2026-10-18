import { getLogger, type Logger } from "../../../shared/logger";
import { type AuditStore, recordAuditEvent } from "../audit";
import { gatewayAdminCredentialControls } from "./admin-credential";
import { gatewayEndpointControls } from "./endpoint-config";
import {
  createGatewayVirtualKeyDeactivationClient,
  type GatewayVirtualKeyDeactivationClient,
} from "./key-renewal";

/*
 * The revocation-side key retirement (Bifrost 05.7, AC08/Q25): when a person revokes an
 * authorization, every key version the grant still holds must stop working — HERE, in the
 * revocation's own commit, and at the GATEWAY, where an old key would otherwise keep
 * starting new work until its short term ran out.
 *
 * THE LOCAL HALF IS NOT THIS MODULE'S. The grant flip and the credentialVersion invalidation
 * are one transaction inside the grant service (`revokeForUser`): the rows are the admission
 * paths' source of truth, so a revoked grant refuses the instant it commits, gateway
 * reachable or not. This module owns the REMOTE half — the best-effort asks that make the
 * gateway agree — and one discipline above all:
 *
 * TOTAL, NEVER THROWING. Revocation is the person's decision; it has already happened by
 * the time this seam runs. A gateway that is down, slow, or refusing must not turn a
 * committed revocation into a 500, and must never be retried into a second flip (the
 * idempotent no-op would skip the disable entirely). So this seam resolves normally no
 * matter what the transport does: every deactivation is attempted, every failure is
 * recorded — one audit row per failed key, naming the grant and the remote key id — and the
 * residual risk (a gateway still honoring a disabled-here key until its own expiry or the
 * 05.8 sync's next read) is exactly what the audit row lets an operator act on.
 *
 * CONCURRENT, NOT SERIAL. The deactivations are independent asks about independent keys;
 * running them together bounds a revocation's wait by one transport deadline instead of N.
 */
export type GatewayGrantKeyRevocator = (input: {
  grantId: string;
  gatewayVirtualKeyIds: string[];
}) => Promise<void>;

/** What a failed remote disable records: the act, the key, and the transport's own reason. */
function reasonCodeOf(error: unknown): string {
  if (
    error instanceof Error &&
    "reasonCode" in error &&
    typeof (error as { reasonCode?: unknown }).reasonCode === "string"
  ) {
    return (error as { reasonCode: string }).reasonCode;
  }
  return "gateway_key_revocation_deactivation_unknown";
}

export function createGrantKeyRevocator(deps: {
  /** 05.6's deactivation transport (`PUT is_active:false`, 404 reads as already-gone). */
  deactivationClient: GatewayVirtualKeyDeactivationClient;
  auditStore?: AuditStore;
  log?: Logger;
}): GatewayGrantKeyRevocator {
  const log = deps.log ?? getLogger("server");
  return async ({ grantId, gatewayVirtualKeyIds }) => {
    if (gatewayVirtualKeyIds.length === 0) return;
    const attempts = await Promise.allSettled(
      gatewayVirtualKeyIds.map((gatewayVirtualKeyId) =>
        deps.deactivationClient.deactivateVirtualKey({ gatewayVirtualKeyId }),
      ),
    );
    for (const [index, attempt] of attempts.entries()) {
      if (attempt.status === "fulfilled") continue;
      const gatewayVirtualKeyId = gatewayVirtualKeyIds[index];
      if (gatewayVirtualKeyId === undefined) continue;
      const reason = attempt.reason;
      log.warn(
        {
          type: "gateway-key-revocation-deactivation-failed",
          grantId,
          gatewayVirtualKeyId,
          reasonCode: reasonCodeOf(reason),
          error: reason instanceof Error ? reason.message : String(reason),
        },
        "The gateway refused or could not be asked to disable a revoked authorization's key; the local revocation stands and the key is recorded as possibly still honored remotely.",
      );
      if (deps.auditStore) {
        // The revocation itself is already a fact; an audit write that fails is a logging
        // concern here, not a reason to fail the person's revocation answer.
        try {
          await recordAuditEvent(deps.auditStore, {
            eventType: "gateway.key_revocation_deactivation_failed",
            targetType: "gateway_virtual_key",
            targetId: gatewayVirtualKeyId,
            payload: {
              grantId,
              gatewayVirtualKeyId,
              reasonCode: reasonCodeOf(reason),
            },
          });
        } catch (error) {
          log.error(
            { type: "gateway-key-revocation-audit-failed", grantId, gatewayVirtualKeyId, error },
            "The failed remote-key disable could not be recorded in the audit trail.",
          );
        }
      }
    }
  };
}

/**
 * The deployment-composed revocator: the same installed controls the issuance and renewal
 * transports read (endpoint 01.1, credential 01.2) behind 05.6's deactivation client, with
 * the total, audit-backed semantics above. Missing controls surface as per-key transport
 * refusals — recorded like any other failed disable, never thrown.
 */
export function createDeploymentGrantKeyRevocator(options: {
  auditStore?: AuditStore;
}): GatewayGrantKeyRevocator {
  const endpointControls = gatewayEndpointControls();
  const credentialControls = gatewayAdminCredentialControls();
  return createGrantKeyRevocator({
    deactivationClient: createGatewayVirtualKeyDeactivationClient({
      readGatewayEndpoint: async () =>
        endpointControls ? endpointControls.readGatewayEndpoint() : undefined,
      resolveGatewayAdminCredential: () => {
        if (!credentialControls) {
          throw new Error("The gateway admin credential is not configured.");
        }
        return credentialControls.resolveGatewayAdminCredential();
      },
    }),
    auditStore: options.auditStore,
  });
}
