import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  PackageConfig,
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
