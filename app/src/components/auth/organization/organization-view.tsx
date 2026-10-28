import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import type { DirectoryScope } from "@/lib/enterprise/tenant/directory";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  findSelection,
  workspaceScopeListingQueryOptions,
} from "@/lib/enterprise/tenant/selection";
import { OrganizationMembersCard } from "./organization-members-card";
import { OrganizationSettingsCards } from "./organization-settings-cards";

/*
 * The fixed registry's Organization entry view (T04.09), OpenBot's adaptation of the pinned
 * source's src/components/organization/organization-view.tsx. Mounted only through
 * OpenBotOrganizationSlot, inside the scope provider the route composes.
 *
 * ONE PAGE, TWO VIEWS, THE ROUTER'S OWN URLS. /organization/settings and /organization/members
 * are TanStack routes on the existing Router (the kit's basePath/viewPaths made concrete), not a
 * second navigation scheme. What each view shows is decided by the listing's own rows: the
 * verified selection names the company and the team, the row's capabilities and binding fields
 * name what may be written, and the server's refusals do the rest. No selection is an honest
 * empty state with its next step, never a fabricated company.
 */
export function OrganizationView(): ReactElement {
  const { t } = useTranslation("company-admin");
  const scope = useScopedCache();
  const open = scope.status === "open" ? scope : null;
  const params = useParams({ strict: false }) as { view?: string };
  const view = params.view === "members" ? "members" : "settings";
  const listing = useQuery({
    ...workspaceScopeListingQueryOptions(open?.userId ?? ""),
    enabled: open !== null,
  });

  if (open === null) {
    return (
      <PageShell
        title={t("organization.title")}
        description={t("organization.description")}
      >
        <TableSkeleton />
      </PageShell>
    );
  }

  if (open.selection === null) {
    return (
      <PageShell
        title={t("organization.title")}
        description={t("organization.description")}
      >
        <Empty className="mt-8 border-border">
          <EmptyHeader>
            <EmptyTitle>{t("organization.noSelection.title")}</EmptyTitle>
            <EmptyDescription>
              {t("organization.noSelection.description")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  if (listing.isPending) {
    return (
      <PageShell
        title={t("organization.title")}
        description={t("organization.description")}
      >
        <TableSkeleton />
      </PageShell>
    );
  }

  if (listing.isError || listing.data === undefined) {
    return (
      <PageShell
        title={t("organization.title")}
        description={t("organization.description")}
      >
        <Empty className="mt-8 border-border">
          <EmptyHeader>
            <EmptyTitle>{t("organization.failed.title")}</EmptyTitle>
            <EmptyDescription>
              {t("organization.failed.description")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        <Button
          className="mt-3"
          onClick={() => void listing.refetch()}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </PageShell>
    );
  }

  const found = findSelection(listing.data, open.selection);
  if (found === null) {
    // The listing no longer names the pair in force (a switch raced the read): the page says
    // choose again rather than showing another company's facts.
    return (
      <PageShell
        title={t("organization.title")}
        description={t("organization.description")}
      >
        <Empty className="mt-8 border-border">
          <EmptyHeader>
            <EmptyTitle>{t("organization.noSelection.title")}</EmptyTitle>
            <EmptyDescription>
              {t("organization.noSelection.description")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  const directoryScope: DirectoryScope = { ...open, selection: open.selection };

  return (
    <PageShell
      title={t("organization.title")}
      description={t("organization.description")}
    >
      <nav
        aria-label={t("organization.title")}
        className="flex flex-wrap gap-2"
      >
        <Link
          to="/organization/$view"
          params={{ view: "settings" }}
          activeOptions={{ exact: true }}
          activeProps={{
            className:
              "border-border bg-accent text-accent-foreground rounded-md border px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
          }}
          className="border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md border px-3 py-1.5 text-sm whitespace-nowrap transition-colors"
        >
          {t("organization.view.settings")}
        </Link>
        <Link
          to="/organization/$view"
          params={{ view: "members" }}
          activeOptions={{ exact: true }}
          activeProps={{
            className:
              "border-border bg-accent text-accent-foreground rounded-md border px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
          }}
          className="border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md border px-3 py-1.5 text-sm whitespace-nowrap transition-colors"
        >
          {t("organization.view.members")}
        </Link>
      </nav>
      {view === "members" ? (
        <OrganizationMembersCard scope={directoryScope} />
      ) : (
        <OrganizationSettingsCards
          scope={directoryScope}
          company={found.company}
        />
      )}
    </PageShell>
  );
}
