import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  readStoredSelection,
  workspaceScopeListingQueryOptions,
} from "@/lib/enterprise/tenant/selection";
import type { PluginPackageScope } from "./queries";

/**
 * Shared derivation for every plugin-package surface: the shelf reads under the
 * team the person last chose explicitly, and the install verb belongs to the
 * selected company's `tenant_admin` role — never the deployment-admin role and
 * never a guess. The server re-authorizes every plan/apply regardless of what
 * this returns; a stale or wrong role here only hides or shows a button.
 */
export function usePackageScope(options?: { enabled?: boolean }): {
  scope: PluginPackageScope | null;
  canInstall: boolean;
  currentUserPending: boolean;
  currentUserError: boolean;
} {
  const me = useQuery(currentUserQueryOptions());
  const stored = me.data ? readStoredSelection(me.data.id) : null;
  const scope =
    me.data && stored
      ? {
          tenantId: stored.tenantId,
          workspaceId: stored.workspaceId,
          principalId: me.data.id,
        }
      : null;
  const listing = useQuery({
    ...workspaceScopeListingQueryOptions(me.data?.id ?? ""),
    enabled: (options?.enabled ?? true) && me.data != null,
  });
  const company =
    stored === null
      ? null
      : (listing.data?.companies.find(
          (candidate) => candidate.tenantId === stored.tenantId,
        ) ?? null);
  return {
    scope,
    canInstall: company?.role === "tenant_admin",
    currentUserPending: me.isPending,
    currentUserError: me.isError,
  };
}
