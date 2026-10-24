import {
  mutationOptions,
  type QueryClient,
  useMutation,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  PackageConfig,
  PackageExpertCreatedDTO,
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
 *
 * PKG04 ADDS EXPERT INSTANTIATION on that same discipline, with one stricter fact: the body
 * carries ONLY identity + CAS revision + display name. The created Bot's profile content is the
 * server's business, read from the verified artifact — nothing a client sends can shape it.
 */

const PACKAGE_ROOT = "/api/enterprise/plugin-packages";

export type PackagePlanOperation = "install" | "upgrade" | "rollback";

export type PackagePlanRequest = {
  scope: PluginPackageScope;
  packageKey: string;
  version: string;
  config: PackageConfig;
  /**
   * PKG06 (#465): an install plan carries no revision; an upgrade or rollback
   * plan carries the EXACT revision the caller read — the server's CAS. The
   * operation decides the preview the server answers with; it never decides
   * authority, which the server re-checks per write.
   */
  operation: PackagePlanOperation;
  expectedRevision: number | null;
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
          operation: request.operation,
          packageKey: request.packageKey,
          version: request.version,
          expectedRevision: request.expectedRevision,
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

/**
 * One expert-creation attempt (PKG04A): the installed revision's template resource, the CAS
 * revision the caller read, and the one field the wire contract lets the caller pick — the
 * display name — plus one idempotency key.
 */
export type PackageExpertCreateRequest = {
  scope: PluginPackageScope;
  installId: string;
  resourceId: string;
  expectedRevision: number;
  name: string;
  idempotencyKey: string;
};

/**
 * Create one scoped Bot from an installed package's expert template
 * (POST …/installs/:installId/experts/:resourceId).
 *
 * THE BODY IS EXACTLY `PackageExpertCreateInputSchema`. Summary and system prompt never travel:
 * the server writes the new Bot's profile from the installed revision's VERIFIED template file,
 * so a tampered client cannot smuggle endpoint/auth fields or remote-runtime config into a
 * package Bot. Scope and actor never travel either — the server derives creator and ownership
 * from the trusted headers the client attaches from `request.scope`. A replay with the same
 * (actor, idempotency key) answers the SAME agentId, so the caller keeps ONE key per dialog open
 * and reuses it for retries of the same creation intent.
 */
export function useInstantiateExpert(queryClient: QueryClient) {
  return useMutation(
    mutationOptions({
      mutationFn: async (
        request: PackageExpertCreateRequest,
      ): Promise<PackageExpertCreatedDTO> => {
        const response = await client(
          `${PACKAGE_ROOT}/installs/${encodeURIComponent(request.installId)}/experts/${encodeURIComponent(request.resourceId)}`,
          {
            method: "POST",
            body: {
              installId: request.installId,
              resourceId: request.resourceId,
              expectedRevision: request.expectedRevision,
              name: request.name,
            },
            headers: { "idempotency-key": request.idempotencyKey },
            tenantId: request.scope.tenantId,
            workspaceId: request.scope.workspaceId,
            fallback: "The expert could not be created.",
          },
        );
        return (await response.json()) as PackageExpertCreatedDTO;
      },
      onSuccess: async (_expert, request) => {
        // Exactly the one install-detail entry whose resources the creation consumed.
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
 * One lifecycle attempt (PKG07): the install, the exact target state, the revision the caller
 * read (the server's CAS) and one idempotency key.
 */
export type PackageLifecycleRequest = {
  scope: PluginPackageScope;
  installId: string;
  status: "enabled" | "disabled" | "uninstalled";
  expectedRevision: number;
  idempotencyKey: string;
};

/**
 * Move one install between enabled / disabled / uninstalled
 * (PATCH …/installs/:installId/status).
 *
 * THE BODY IS EXACTLY `PackageInstallStatusUpdateSchema`: target status plus CAS revision. Scope
 * and actor ride as the selection headers the server re-derives, never as body fields. One key
 * per dialog open, so a double click or a retry of the SAME intent replays the server's answer
 * instead of ratcheting the install generation — the server is what actually guarantees it.
 *
 * Success invalidates the captured scope's package tree: the card, the detail facts and the
 * allowed actions all derive from state this write changed.
 */
export function usePackageLifecycle(queryClient: QueryClient) {
  return useMutation(
    mutationOptions({
      mutationFn: async (
        request: PackageLifecycleRequest,
      ): Promise<PackageInstallDTO> => {
        const response = await client(
          `${PACKAGE_ROOT}/installs/${encodeURIComponent(request.installId)}/status`,
          {
            method: "PATCH",
            body: {
              status: request.status,
              expectedRevision: request.expectedRevision,
            },
            headers: { "idempotency-key": request.idempotencyKey },
            tenantId: request.scope.tenantId,
            workspaceId: request.scope.workspaceId,
            fallback: "The package install could not be updated.",
          },
        );
        return (await response.json()) as PackageInstallDTO;
      },
      onSuccess: async (_install, request) => {
        await queryClient.invalidateQueries({
          queryKey: pluginPackageKeys.scope(request.scope),
        });
      },
    }),
  );
}
