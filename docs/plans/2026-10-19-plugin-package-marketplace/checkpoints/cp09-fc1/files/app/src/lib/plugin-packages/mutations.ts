import {
  mutationOptions,
  type QueryClient,
  useMutation,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  PackageConfig,
  PackageGrantDTO,
  PackageGrantResource,
  PackageInstallDTO,
  PackagePlanDTO,
} from "../../../../shared/enterprise/plugin-package-contracts";
import { type PluginPackageScope, pluginPackageKeys } from "./queries";

/**
 * PKG02 install writes: preview a plan, then confirm it exactly once.
 *
 * THE SCOPE IS CAPTURED PER CALL, NOT READ FROM A SINGLETON. Both mutations take the selection
 * their dialog was opened under as an argument, send it as the scope headers, and — for apply —
 * invalidate only that scope's keys. A response that arrives after the person switched teams
 * therefore refetches the old tree at most; it can never write the new team's cache.
 *
 * NOTHING HERE CARRIES A SECRET. The plan body is the contract's flat non-secret config plus the
 * exact package identity; apply carries only the server-generated plan id and one idempotency key
 * per confirm attempt.
 *
 * PKG03 ADDS THE BOT GRANT WRITES, on the same discipline: the scope is an argument that rides as
 * the selection headers (never a body field), one idempotency key per attempt, and success
 * invalidates exactly the affected install-detail key — the one entry whose authorization state
 * the write changed — so the affected screen refetches and everything else keeps its cache.
 */

const PACKAGE_ROOT = "/api/enterprise/plugin-packages";

export type PackagePlanRequest = {
  scope: PluginPackageScope;
  packageKey: string;
  version: string;
  config: PackageConfig;
};

export type PackageApplyRequest = {
  scope: PluginPackageScope;
  planId: string;
  idempotencyKey: string;
};

/** A preview is read-only: creating one changes no install and calls no vendor. */
export function packagePlanMutationOptions() {
  return mutationOptions({
    mutationFn: async (
      request: PackagePlanRequest,
    ): Promise<PackagePlanDTO> => {
      const response = await client(`${PACKAGE_ROOT}/plans`, {
        method: "POST",
        body: {
          operation: "install",
          packageKey: request.packageKey,
          version: request.version,
          // PKG02 installs only; an existing install's revision CAS arrives with PKG06.
          expectedRevision: null,
          config: request.config,
          connectorInstalls: {},
        },
        tenantId: request.scope.tenantId,
        workspaceId: request.scope.workspaceId,
        fallback: "The install preview could not be created.",
      });
      return (await response.json()) as PackagePlanDTO;
    },
  });
}

/**
 * One confirm attempt, one idempotency key. The caller generates the key and the mutation only
 * transports it; a retry after an answer is a new attempt with its own key, as the server's
 * receipt model expects.
 */
export function packageApplyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (
      request: PackageApplyRequest,
    ): Promise<PackageInstallDTO> => {
      const response = await client(
        `${PACKAGE_ROOT}/plans/${encodeURIComponent(request.planId)}/apply`,
        {
          method: "POST",
          headers: { "idempotency-key": request.idempotencyKey },
          tenantId: request.scope.tenantId,
          workspaceId: request.scope.workspaceId,
          fallback: "The package could not be installed.",
        },
      );
      return (await response.json()) as PackageInstallDTO;
    },
    onSuccess: async (_install, request) => {
      /*
       * Only the captured scope's tree. A late answer from team A invalidates A's list/detail/
       * install entries; team B's keys share no prefix and are never touched.
       */
      await queryClient.invalidateQueries({
        queryKey: pluginPackageKeys.scope(request.scope),
      });
    },
  });
}

/** One grant attempt: the exact resources, the CAS target, and one idempotency key. */
export type PackageGrantRequest = {
  scope: PluginPackageScope;
  installId: string;
  botId: string;
  /** null = first grant for this install/bot pair; else the grant revision the caller read. */
  expectedGrantRevision: number | null;
  resources: PackageGrantResource[];
  idempotencyKey: string;
};

/** One revoke attempt: identity plus CAS target; the server supersedes the active grant. */
export type PackageGrantRevokeRequest = {
  scope: PluginPackageScope;
  installId: string;
  botId: string;
  expectedGrantRevision: number | null;
  idempotencyKey: string;
};

/**
 * Grant skill resources to one Bot (PUT …/installs/:installId/bots/:botId/grants).
 *
 * The body is exactly `PackageGrantInputSchema`: install and bot identity, the CAS target and the
 * resources. Scope and actor never travel in it — the server derives them from the trusted
 * headers the client attaches from `request.scope`. A Bot grant authorizes pinned skill use in
 * runs; it never changes what the install itself may do.
 */
export function usePackageGrant(queryClient: QueryClient) {
  return useMutation(
    mutationOptions({
      mutationFn: async (
        request: PackageGrantRequest,
      ): Promise<PackageGrantDTO> => {
        const response = await client(
          `${PACKAGE_ROOT}/installs/${encodeURIComponent(request.installId)}/bots/${encodeURIComponent(request.botId)}/grants`,
          {
            method: "PUT",
            body: {
              installId: request.installId,
              botId: request.botId,
              expectedGrantRevision: request.expectedGrantRevision,
              resources: request.resources,
            },
            headers: { "idempotency-key": request.idempotencyKey },
            tenantId: request.scope.tenantId,
            workspaceId: request.scope.workspaceId,
            fallback: "The Bot grant could not be added.",
          },
        );
        return (await response.json()) as PackageGrantDTO;
      },
      onSuccess: async (_grant, request) => {
        // Exactly the one install-detail entry whose authorization state changed.
        await queryClient.invalidateQueries({
          queryKey: pluginPackageKeys.installDetail(
            request.scope,
            request.installId,
          ),
        });
      },
    }),
  );
}

/**
 * Revoke one Bot's grant (DELETE …/installs/:installId/bots/:botId/grants). The optional body
 * carries only the CAS target; an absent body means null, so the UI sends the revision it read.
 */
export function usePackageGrantRevoke(queryClient: QueryClient) {
  return useMutation(
    mutationOptions({
      mutationFn: async (
        request: PackageGrantRevokeRequest,
      ): Promise<PackageGrantDTO> => {
        const response = await client(
          `${PACKAGE_ROOT}/installs/${encodeURIComponent(request.installId)}/bots/${encodeURIComponent(request.botId)}/grants`,
          {
            method: "DELETE",
            body: { expectedGrantRevision: request.expectedGrantRevision },
            headers: { "idempotency-key": request.idempotencyKey },
            tenantId: request.scope.tenantId,
            workspaceId: request.scope.workspaceId,
            fallback: "The Bot grant could not be revoked.",
          },
        );
        return (await response.json()) as PackageGrantDTO;
      },
      onSuccess: async (_grant, request) => {
        await queryClient.invalidateQueries({
          queryKey: pluginPackageKeys.installDetail(
            request.scope,
            request.installId,
          ),
        });
      },
    }),
  );
}
