import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { entitlementsQueryOptions } from "@/lib/billing/queries";

export const Route = createFileRoute("/_authed/settings/billing")({
  component: RouteComponent,
});

/**
 * What this deployment is entitled to.
 *
 * The answer is the server's `{active, codes}` and nothing more — the plan's own name is the
 * provider's word for it, and a person reading this page cares what it unlocks, not what it is
 * called upstream. An administrator changes the plan (Admin → Billing → Sync, or at the provider);
 * everybody else reads the result here.
 */
function RouteComponent() {
  const { t } = useTranslation("settings");
  const entitlements = useQuery(entitlementsQueryOptions);

  return (
    <PageShell
      title={t("billing.title")}
      description={t("billing.description")}
    >
      {entitlements.isPending ? null : entitlements.error ? (
        <PageEmpty>{(entitlements.error as Error).message}</PageEmpty>
      ) : entitlements.data.active ? (
        <PageSection
          title={t("billing.includedTitle")}
          description={t("billing.includedDescription")}
        >
          {entitlements.data.codes.length === 0 ? (
            <PageEmpty>{t("billing.noCodes")}</PageEmpty>
          ) : (
            <ul className="mt-4 flex flex-wrap gap-2">
              {entitlements.data.codes.map((code) => (
                <li
                  key={code.code}
                  className="bg-muted text-muted-foreground rounded-full border px-3 py-1 font-mono text-xs"
                >
                  {code.code}
                </li>
              ))}
            </ul>
          )}
        </PageSection>
      ) : (
        <PageEmpty>{t("billing.inactive")}</PageEmpty>
      )}
    </PageShell>
  );
}
