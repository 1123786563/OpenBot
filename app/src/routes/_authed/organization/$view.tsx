import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { type ReactElement, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { OrganizationView } from "@/components/auth/organization/organization-view";
import { PageShell } from "@/components/layout/page-shell";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import {
  OpenBotOrganizationScopeProvider,
  OpenBotOrganizationSlot,
  openBotScopeSelectionAdapter,
} from "@/lib/auth/organization-plugin";
import { OpenBotAuthProvider } from "@/lib/auth/ui-provider";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { workspaceScopeListingQueryOptions } from "@/lib/enterprise/tenant/selection";

/*
 * The fixed registry Organization page route (T04.09, Issue #553). One route on the existing
 * Router carries both views the manifest names (settings and members — the kit's viewPaths made
 * concrete); anything else is not a page here and 404s before a component mounts.
 *
 * The route owns the composition the declaration gate requires: the verified provider chain
 * (OpenBotAuthProvider → the scope adapter bound to the ONE selection source → the slot), with
 * OrganizationView behind the gate. The view itself reads the same scope and listing from the
 * shared cache, so nothing here fetches twice and nothing decides capability outside the
 * server's answers.
 */
export const Route = createFileRoute("/_authed/organization/$view")({
  beforeLoad: ({ params }) => {
    if (params.view !== "settings" && params.view !== "members") {
      throw notFound();
    }
  },
  component: OrganizationPage,
});

function OrganizationPage(): ReactElement {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const open = scope.status === "open" ? scope : null;
  const listing = useQuery({
    ...workspaceScopeListingQueryOptions(open?.userId ?? ""),
    enabled: open !== null,
  });
  const userId = open?.userId ?? null;
  // The adapter is composed ONCE per signed-in user and stays referentially stable for the life
  // of the provider tree: recomposing it would rebuild the restricted auth-client Proxy the
  // adapted provider carries, and react-dom's dev render logger crashes diffing that proxy
  // across a re-render (proven in the T04.09 GREEN run). The listing snapshot it captures feeds
  // switcher reads only, and this page mounts no switcher — OrganizationView reads the live
  // listing itself.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listing.data deliberately captured once, see above
  const adapter = useMemo(
    () =>
      userId === null
        ? null
        : openBotScopeSelectionAdapter({
            userId,
            queryClient,
            listing: listing.data ?? null,
          }),
    [userId, queryClient],
  );

  if (open === null || adapter === null) {
    // The scope source has not answered: no provider mounts against a guessed identity.
    return (
      <PageShell
        title={t("organization.title")}
        description={t("organization.description")}
      >
        <TableSkeleton />
      </PageShell>
    );
  }

  return (
    <OpenBotAuthProvider>
      <OpenBotOrganizationScopeProvider adapter={adapter}>
        <OpenBotOrganizationSlot
          name="OrganizationView"
          component={OrganizationView}
        />
      </OpenBotOrganizationScopeProvider>
    </OpenBotAuthProvider>
  );
}
