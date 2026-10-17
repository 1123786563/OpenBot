import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The Bifrost gateway as the administrator's screen reads it (Bifrost #214, 01.8).
 *
 * The server's status answer is the whole truth this page draws from — the
 * readiness verdict with every blocking reason, the saved endpoint and its
 * configVersion, the credential's fingerprint (never its key), the rate, and
 * the persisted probe and extension-negotiation records. There is no field in
 * this type a secret could arrive in; the plaintext exists only long enough
 * for the credential write to carry it, and is never echoed back.
 */

/** Every reason the readiness gate can name; each has a displayable sentence. */
export const GATEWAY_READINESS_REASON_CODES = [
  "gateway_readiness_endpoint_not_configured",
  "gateway_readiness_endpoint_unavailable",
  "gateway_readiness_credential_not_configured",
  "gateway_readiness_credential_unavailable",
  "gateway_readiness_probe_missing",
  "gateway_readiness_probe_not_ok",
  "gateway_readiness_probe_unavailable",
  "gateway_readiness_extension_not_negotiated",
  "gateway_readiness_extension_absent",
  "gateway_readiness_extension_incompatible",
  "gateway_readiness_extension_unavailable",
  "gateway_readiness_rate_not_configured",
  "gateway_readiness_rate_unavailable",
  "gateway_readiness_gate_unavailable",
] as const;

export type GatewayReadinessReasonCode =
  (typeof GATEWAY_READINESS_REASON_CODES)[number];

export type GatewayReadiness = {
  ready: boolean;
  blockingReasons: readonly string[];
  configVersion: number;
  checkedAt: string;
};

export type GatewayEndpointView = {
  baseUrl: string;
  requestTimeoutMs: number;
  configVersion: number;
};

export type GatewayCredentialView =
  | {
      state: "configured";
      configVersion: number;
      fingerprint: string;
      updatedAt: string;
    }
  | { state: "unconfigured" };

export type GatewayProbeView = {
  status: string;
  reasonCode: string;
  checkedAt: string;
  configVersion: number;
  durationMs: number;
};

export type GatewayExtensionView = {
  creditAdmissionExtension: string;
  extensionVersion: string | null;
  reasonCode: string;
  supportedRange: string | null;
  checkedAt: string;
  configVersion: number;
};

export type GatewayRateView =
  | {
          configured: true;
          numerator: string;
          denominator: string;
          rateVersion: number;
          source: string;
      }
  | { configured: false; reason: string; explanation: string };

export type GatewayAdminStatus = {
  readiness: GatewayReadiness;
  endpoint: GatewayEndpointView | null;
  credential: GatewayCredentialView | null;
  probe: GatewayProbeView | null;
  extension: GatewayExtensionView | null;
  rate: GatewayRateView;
};

export const gatewayKeys = {
  all: ["gateway"] as const,
  status: () => [...gatewayKeys.all, "status"] as const,
};

export function gatewayStatusQueryOptions() {
  return queryOptions({
    queryKey: gatewayKeys.status(),
    queryFn: async (): Promise<GatewayAdminStatus> => {
      // The status answer is the payload itself — there is no envelope key to
      // unwrap, so the response is read here (the same shape auth/queries uses).
      const response = await client("/api/admin/gateway/status", {
        fallbackKey: "gateway.load",
      });
      return (await response.json()) as GatewayAdminStatus;
    },
  });
}
