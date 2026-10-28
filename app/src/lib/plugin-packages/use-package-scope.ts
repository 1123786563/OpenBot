import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { workspaceScopeListingQueryOptions } from "@/lib/enterprise/tenant/selection";
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
  listingPending: boolean;
  listingError: boolean;
  /** Retry for a failed listing; the pane offers it on the listingError face. */
  listingRefetch: () => void;
} {
  const me = useQuery(currentUserQueryOptions());
  // The selection comes from the one scope seam (MOD19 / Issue #639, T2), not a private storage
  // read: `useScopedCache` answers from the same reactive entry every scoped surface reads, so a
  // switch in this tab or another lands here on the same generation discipline, and the personal
  // context (selection null) reads exactly as the old direct read did.
  const cache = useScopedCache();
  const stored = cache.status === "open" ? cache.selection : null;
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
  // The revocation judgment is `findSelection`'s (lib/enterprise/tenant/selection.ts):
  // the listing is the live membership fact — a suspended company hides whole, a
  // suspended team hides alone — so the stored pair survives only while BOTH halves
  // are still listed. A team dropped from its company is revoked exactly like a
  // company dropped from the deployment; an erroring listing stays an error, never
  // an authorization fact.
  const company =
    stored === null
      ? null
      : (listing.data?.companies.find(
          (candidate) => candidate.tenantId === stored.tenantId,
        ) ?? null);
  const team =
    stored === null || company === null
      ? null
      : (company.teams.find(
          (candidate) => candidate.workspaceId === stored.workspaceId,
        ) ?? null);
  const revoked = company === null || team === null;
  return {
    // No scope leaves this hook until the listing has settled on a pair it still
    // knows: a stored selection the listing no longer knows — at either level —
    // is revoked, not a scope to keep browsing under, and an in-flight listing
    // must not leak requests at a stale tenant either. The shelf shows its
    // select-a-team state meanwhile.
    scope: stored === null ? null : listing.isPending || revoked ? null : scope,
    // The install verb speaks only for a selection the listing still knows; with
    // scope null no pane renders it anyway.
    canInstall: !revoked && company?.role === "tenant_admin",
    currentUserPending: me.isPending,
    currentUserError: me.isError,
    listingPending: me.data != null && listing.isPending,
    listingError: listing.isError,
    listingRefetch: () => {
      void listing.refetch();
    },
  };
}
