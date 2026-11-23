import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AstryxAdminPage } from "@/components/admin/astryx-admin-page";
import {
  ModelAllowlistSection,
  ModelChoiceSection,
  ModelUsageSection,
  ProviderSection,
} from "@/components/admin/controls/model-sections";
import { Button } from "@/components/ui/button";
import { enterpriseOverviewQueryOptions } from "@/lib/enterprise/queries";
import { availableModelsQueryOptions } from "@/lib/models/queries";

export const Route = createFileRoute("/_authed/admin/providers")({
  component: ProvidersPage,
});

/**
 * Admin, Providers: what serves the models built-in Bots run on, which models people may pick, and
 * what Bots ran on. Named for the provider rather than the model so a second provider has a place
 * to go.
 *
 * One person on their own machine is offered every model the credential lists, so there is nothing
 * to allow and no allowlist is shown. A team picks among the models an admin allows here.
 */
export function ProvidersPage() {
  const available = useQuery(availableModelsQueryOptions());
  /*
   * The settings read is said once for the whole page. Every section below reads it, and each
   * carrying its own copy drew three identical alerts whose three Retries were really one action;
   * the sections stay quiet about it and this banner is the single place it is said.
   */
  const settings = useQuery(enterpriseOverviewQueryOptions());
  const team = available.data?.exposure === "allowed";
  return (
    <AstryxAdminPage
      description={
        team
          ? "See which provider serves your Bots' models, and choose which models people may pick. All changes appear in Audit."
          : "See which provider serves your Bots' models and what they ran on."
      }
      title="Providers"
    >
      {settings.isError ? (
        <div className="mb-8 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't load these settings.
          </p>
          <Button
            disabled={settings.isFetching}
            onClick={() => void settings.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {settings.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : null}
      <ProviderSection />
      <ModelChoiceSection />
      {team ? <ModelAllowlistSection /> : null}
      <ModelUsageSection team={team} />
    </AstryxAdminPage>
  );
}
