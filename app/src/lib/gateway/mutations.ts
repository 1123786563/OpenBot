import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  gatewayKeys,
  type ModelScopeView,
} from "./queries";

/**
 * The administrator's gateway actions (Bifrost #214, 01.8). Each one changes
 * what the server has on file, so each invalidates the status read on success
 * — the screen then shows the verdict the server actually holds, never one it
 * guessed. The credential write goes to 01.2's dedicated route, whose answer
 * is the redacted status only; a key's plaintext is sent once and never
 * displayed anywhere.
 */

export type GatewayEndpointSave = {
  baseUrl: string;
  requestTimeoutMs: number;
};

export type GatewayEndpointSaved = {
  endpoint: { baseUrl: string; requestTimeoutMs: number; configVersion: number };
};

export function saveGatewayEndpointMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: GatewayEndpointSave) =>
      client<GatewayEndpointSaved>("/api/admin/gateway/endpoint", "endpoint", {
        method: "PUT",
        body: input,
        fallbackKey: "gateway.operation",
      }) as Promise<GatewayEndpointSaved>,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: gatewayKeys.all }),
  });
}

export type GatewayRateSave = {
  numerator: string;
  denominator: string;
};

export type GatewayRateSaved = {
  rate: { numerator: string; denominator: string; rateVersion: number };
};

export function saveGatewayRateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: GatewayRateSave) =>
      client<GatewayRateSaved>("/api/admin/gateway/rate", "rate", {
        method: "PUT",
        body: input,
        fallbackKey: "gateway.operation",
      }) as Promise<GatewayRateSaved>,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: gatewayKeys.all }),
  });
}

export type GatewayCredentialSaved = {
  status:
    | {
        state: "configured";
        configVersion: number;
        fingerprint: string;
        updatedAt: string;
      }
    | { state: "unconfigured" };
};

export function saveGatewayCredentialMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (input: { adminKey: string }) =>
      client<GatewayCredentialSaved>(
        "/api/admin/gateway/credential",
        "status",
        {
          method: "PUT",
          body: input,
          fallbackKey: "gateway.operation",
        },
      ) as Promise<GatewayCredentialSaved>,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: gatewayKeys.all }),
  });
}

export type GatewayProbeRunResponse = {
  probe: {
    status: string;
    reasonCode: string;
    checkedAt: string;
    configVersion: number;
    durationMs: number;
  };
  negotiation: {
    negotiated: boolean;
    negotiation: {
      creditAdmissionExtension: string;
      extensionVersion: string | null;
      reasonCode: string;
      supportedRange: string | null;
      checkedAt: string;
      configVersion: number;
    };
  } | null;
};

export function runGatewayProbeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<GatewayProbeRunResponse> => {
      // The probe answer is the payload itself — no envelope key to unwrap.
      const response = await client("/api/admin/gateway/probe", {
        method: "POST",
        fallbackKey: "gateway.operation",
      });
      return (await response.json()) as GatewayProbeRunResponse;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: gatewayKeys.all }),
  });
}

/**
 * The administrator's model open/close action (Bifrost 03.7). The state and
 * the reason travel together — the server refuses a change without a why —
 * and every accepted change is audited server-side. Success invalidates the
 * catalog read, so the screen shows the decision the server actually holds.
 */
export type ModelScopeChange = {
  provider: string;
  model: string;
  capability: string;
  state: "open" | "closed";
  reason: string;
};

export function setModelScopeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: ModelScopeChange): Promise<ModelScopeView> => {
      const response = await client<{ scope: ModelScopeView }>(
        "/api/admin/gateway/models/scope",
        "scope",
        {
          method: "PUT",
          body: input,
          fallbackKey: "gateway.operation",
        },
      );
      return response.scope;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: gatewayKeys.all }),
  });
}

/**
 * The result the manual sync route answers (Bifrost 03.5): the outcome of the
 * same sync the timer runs — what landed on success, or the failing layer's
 * fixed reason code. There is no field here a secret could arrive in.
 */
export type GatewayCatalogSyncResult =
  | {
      status: "ok";
      syncedAt: string;
      appended: number;
      skipped: number;
      record: {
        fetchedAt: string;
        source: string;
        rawItemCount: number;
        configVersion: number;
      };
    }
  | {
      status: "failed";
      stage: "catalog" | "prices";
      reasonCode: string;
      failedAt: string;
    };

/**
 * The administrator's "sync now" action (Bifrost 03.5): the manual trigger
 * rides the same server-side sync implementation and single-flight the
 * automatic cadence uses. A failed sync is still an answered result (the
 * route answers 200 with the failure), so it lands here as data and the page
 * shows the server's own reason code; only a route-level refusal (the sync
 * service absent) rejects and reads as an operation error. Either way the
 * catalog is re-read, so the page lists what the server now holds.
 */
export function runCatalogSyncMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<GatewayCatalogSyncResult> => {
      const response = await client("/api/admin/gateway/catalog/sync", {
        method: "POST",
        fallbackKey: "gateway.operation",
      });
      const body = (await response.json()) as {
        result: GatewayCatalogSyncResult;
      };
      return body.result;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: gatewayKeys.all }),
  });
}
