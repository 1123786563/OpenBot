import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  type CompanyCapabilities,
  companyCapabilitiesQueryOptions,
} from "@/lib/enterprise/tenant/company-admin";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/*
 * The company admin area's chrome (MT095/MT096/MT097, Issues #138-#140): the gate every page in
 * /tenant/admin shares, the capability-driven section list, and the one refused panel each gated
 * section renders when the server answers its refusal.
 *
 * THE ENTRY IS THE SERVER'S ANSWER (AC1 of #138). The nav below renders exactly the sections the
 * capability bits say — never a role recomputed here — and a member with no capability at all gets
 * the explicit refusal state, not a redirect home and not a crash. Platform-level admin surfaces
 * (`/admin/**`) are a different plane (MT075) and never appear in this list (AC4 of #138): there
 * is nothing to hide, because this list is derived from company capability bits only.
 */

/** One section the area offers, present only when the server's bit is true. */
export interface CompanyAdminSection {
  readonly to: string;
  readonly label: string;
  readonly enabled: boolean;
}

/**
 * The sections the current member may enter, derived from the capability answer alone. The list
 * is built (not filtered from a master list that names platform surfaces) so a platform entry
 * cannot appear here even by accident of refactoring.
 */
export function companyAdminSections(
  capabilities: CompanyCapabilities,
  t: TFunction<"company-admin">,
): readonly CompanyAdminSection[] {
  const sections: CompanyAdminSection[] = [];
  if (capabilities.peopleAdmin) {
    sections.push({
      to: "/tenant/admin/people",
      label: t("nav.people"),
      enabled: true,
    });
  }
  if (capabilities.peopleAdmin) {
    // The fixed registry's organization pages (T04.09): the company profile and team members
    // surfaces ride the same capability bit as the people section.
    sections.push({
      to: "/organization/settings",
      label: t("nav.organization"),
      enabled: true,
    });
  }
  if (capabilities.auditReader) {
    sections.push({
      to: "/tenant/admin/audit",
      label: t("nav.audit"),
      enabled: true,
    });
  }
  if (capabilities.peopleAdmin) {
    sections.push({
      to: "/tenant/admin/enterprise",
      label: t("nav.enterprise"),
      enabled: true,
    });
  }
  if (capabilities.peopleAdmin) {
    sections.push({
      to: "/tenant/admin/learning",
      label: t("nav.learning"),
      enabled: true,
    });
  }
  if (capabilities.financeReader || capabilities.billingManager) {
    sections.push({
      to: "/tenant/admin/billing",
      label: t("nav.billing"),
      enabled: true,
    });
  }
  return sections;
}

/**
 * The area's layout body: the four gate states in order (scope pending → choose-a-company →
 * capabilities answer → refusal or nav), then the page.
 */
export function CompanyAdminArea({ scope }: { scope: ScopedCache }) {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();

  if (scope.status === "pending") {
    return (
      <PageShell title={t("title")} description={t("description")}>
        <TableSkeleton />
      </PageShell>
    );
  }

  if (scope.selection === null) {
    // No company selected is an honest empty state, not an error: the area works inside a
    // selection and nothing has been refused yet.
    return (
      <PageShell title={t("title")} description={t("description")}>
        <Empty className="mt-8 border-border">
          <EmptyHeader>
            <EmptyTitle>{t("gate.noSelection.title")}</EmptyTitle>
            <EmptyDescription>
              {t("gate.noSelection.description")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  return (
    <CompanyAdminAreaWithScope scope={scope} queryClient={queryClient} t={t} />
  );
}

function CompanyAdminAreaWithScope({
  scope,
  queryClient,
  t,
}: {
  scope: Extract<ScopedCache, { status: "open" }>;
  queryClient: ReturnType<typeof useQueryClient>;
  t: TFunction<"company-admin">;
}) {
  const capabilities = useQuery(
    companyCapabilitiesQueryOptions(queryClient, scope),
  );

  if (capabilities.isPending) {
    return (
      <PageShell title={t("title")} description={t("description")}>
        <TableSkeleton />
      </PageShell>
    );
  }

  if (capabilities.isError) {
    // The capability answer itself failed: the entry cannot be decided, so the area says so in
    // its own words — never a fallback that guesses the member's way in.
    return (
      <PageShell title={t("title")} description={t("description")}>
        <Empty className="mt-8 border-border">
          <EmptyHeader>
            <EmptyTitle>{t("gate.unavailable.title")}</EmptyTitle>
            <EmptyDescription>
              {t("gate.unavailable.description")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        <Button
          className="mt-3"
          onClick={() => void capabilities.refetch()}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </PageShell>
    );
  }

  const { peopleAdmin, auditReader, financeReader, billingManager } =
    capabilities.data;
  if (!peopleAdmin && !auditReader && !financeReader && !billingManager) {
    // The explicit refusal state (AC1 of #138): a member with no capability reached the route
    // and is told so — no redirect, no existence leak about what the sections would show.
    return (
      <PageShell title={t("title")} description={t("description")}>
        <Empty className="mt-8 border-border">
          <EmptyHeader>
            <EmptyTitle>{t("gate.refused.title")}</EmptyTitle>
            <EmptyDescription>{t("gate.refused.description")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  const sections = companyAdminSections(capabilities.data, t);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <nav aria-label={t("title")} className="mb-6 flex flex-wrap gap-2">
        {sections.map((section) => (
          <Link
            activeOptions={{ exact: false }}
            activeProps={{
              className:
                "border-border bg-accent text-accent-foreground rounded-md border px-3 py-1.5 text-sm",
            }}
            className="border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md border px-3 py-1.5 text-sm whitespace-nowrap transition-colors"
            key={section.to}
            to={section.to}
          >
            {section.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

/**
 * The refused panel a gated section renders when its read answered the typed refusal: the one
 * sentence the surface owns (its own key), never a code and never a guess at which gate refused.
 */
export function SectionRefused({ message }: { message: string }) {
  return (
    <PageEmpty>
      <span className="text-foreground font-medium">{message}</span>
    </PageEmpty>
  );
}

/** The failed panel a section renders when its read failed for infrastructure reasons. */
export function SectionFailed({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <>
      <PageEmpty>
        <span className="text-foreground font-medium">{message}</span>
      </PageEmpty>
      {onRetry !== undefined ? (
        <Button className="mt-3" onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      ) : null}
    </>
  );
}

/** A section's table shell, kept here so every page's table reads the same way. */
export function SectionTable({
  label,
  head,
  children,
}: {
  label: string;
  head: readonly string[];
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="mt-3 overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: An overflow region needs keyboard focus to scroll in Safari; the region has an accessible name.
      tabIndex={0}
    >
      <table className="w-full text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr className="border-border border-b">
            {head.map((cell) => (
              <th className="px-4 py-2 font-medium" key={cell}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </section>
  );
}

/** The page section wrapper every section page uses, so the area reads as one surface. */
export function SectionPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <PageSection title={title}>
      <p className="text-muted-foreground text-sm">{description}</p>
      {children}
    </PageSection>
  );
}
