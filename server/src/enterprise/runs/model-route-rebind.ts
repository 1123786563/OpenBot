import type { PlatformScope } from "../contracts";
import type { RuntimeModelRoute } from "../models/runtime-adapter";
import { assertTrustedScope } from "../tenancy/store";
import {
  type CanonicalModelRouteSnapshot,
  canonicalizeModelRouteSnapshot,
  type ModelRouteCatalogStore,
  type ModelRouteSnapshotInput,
  type SafeModelRouteSnapshot,
} from "./model-route-catalog";

function fail(code: string): never {
  throw new Error(code);
}

function samePlan(
  admitted: SafeModelRouteSnapshot["plan"],
  current: SafeModelRouteSnapshot["plan"],
): boolean {
  if (!admitted || !current) return admitted === current;
  return (
    admitted.provider === current.provider &&
    admitted.endpointFingerprint === current.endpointFingerprint
  );
}

function sameSnapshot(
  admitted: SafeModelRouteSnapshot,
  current: SafeModelRouteSnapshot,
): boolean {
  return (
    admitted.schemaVersion === current.schemaVersion &&
    admitted.agentId === current.agentId &&
    admitted.provider === current.provider &&
    admitted.defaultModel === current.defaultModel &&
    admitted.credentialSecretRef === current.credentialSecretRef &&
    admitted.nativeBaseUrlFingerprint === current.nativeBaseUrlFingerprint &&
    samePlan(admitted.plan, current.plan)
  );
}

/**
 * Rebind an admitted run's persisted route reference to the current
 * server-selected route. Every authority the admission pinned — provider,
 * model, credential reference, plan endpoint and native destination — must
 * be unchanged, otherwise the rebind fails closed before any credential
 * resolution or network model request. `null` means the catalog row or the
 * current server route is unavailable, never a fallback route. The returned
 * route carries only current server-selected values; no secret from the
 * persisted snapshot is returned or exposed.
 */
export async function rebindModelRoute(input: {
  scope: PlatformScope;
  routeRef: string;
  catalog: Pick<ModelRouteCatalogStore, "get">;
  currentRouteForAgent: (
    agentId: string,
  ) => Promise<ModelRouteSnapshotInput | null>;
  modelCapabilitySecret: string | Uint8Array;
}): Promise<RuntimeModelRoute | null> {
  assertTrustedScope(input.scope);
  if (typeof input.routeRef !== "string" || input.routeRef.length === 0) {
    fail("MODEL_ROUTE_REF_INVALID");
  }
  const stored: CanonicalModelRouteSnapshot | null = await input.catalog.get(
    input.scope,
    input.routeRef,
  );
  if (!stored) return null;
  const currentInput = await input.currentRouteForAgent(
    stored.snapshot.agentId,
  );
  if (!currentInput) return null;
  if (currentInput.agentId !== stored.snapshot.agentId) {
    fail("MODEL_ROUTE_AGENT_MISMATCH");
  }
  const current = canonicalizeModelRouteSnapshot(
    input.scope.tenantId,
    currentInput,
    input.modelCapabilitySecret,
  );
  if (
    current.routeRef !== stored.routeRef ||
    current.agentId !== stored.agentId ||
    !sameSnapshot(stored.snapshot, current.snapshot)
  ) {
    fail("MODEL_ROUTE_DRIFT");
  }
  return currentInput.route;
}
