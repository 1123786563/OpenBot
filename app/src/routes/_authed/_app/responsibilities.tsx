import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { RoutinesList } from "@/components/routines/routines-list";
import { resolveChosenBot, useChosenBotId } from "@/lib/agents/chosen-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";

export const Route = createFileRoute("/_authed/_app/responsibilities")({
  validateSearch: (search: Record<string, unknown>): { view?: "goals" } =>
    search.view === "goals" ? { view: "goals" } : {},
  component: ResponsibilitiesPage,
});

function ResponsibilitiesPage() {
  const { view } = Route.useSearch();
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view === "goals" ? (
        <GoalsOverview />
      ) : (
        <PageShell
          description="Ongoing work across your Bots."
          title="Responsibilities"
        >
          <BotResponsibilities />
        </PageShell>
      )}
    </AstryxSurface>
  );
}

function GoalsOverview() {
  const agents = useQuery(agentListQueryOptions());
  const user = useQuery(currentUserQueryOptions());
  const chosenId = useChosenBotId(user.data?.id);
  const bot = resolveChosenBot(agents.data, chosenId);

  return (
    <PageShell
      title="Goals"
      description={bot ? `Ongoing work for ${bot.name}.` : undefined}
    >
      {agents.isPending || user.isPending ? (
        <p role="status">Loading Goals…</p>
      ) : agents.isError || user.isError ? (
        <p className="text-destructive" role="alert">
          Couldn't load your Goals. Reload the page to try again.
        </p>
      ) : bot ? (
        <div key={bot.id}>
          <nav
            aria-label={`${bot.name}’s work`}
            className="flex flex-wrap gap-x-4 gap-y-2 text-sm"
          >
            <Link
              className="underline underline-offset-4"
              params={{ agentId: bot.id }}
              to="/bots/$agentId/responsibilities"
            >
              Responsibilities
            </Link>
            <Link
              className="underline underline-offset-4"
              params={{ agentId: bot.id }}
              to="/bots/$agentId/routines"
            >
              Routines
            </Link>
            <Link
              className="underline underline-offset-4"
              to="/responsibilities"
            >
              All responsibilities
            </Link>
          </nav>
          <PageSection title="Routines">
            <RoutinesList agentId={bot.id} embedded />
          </PageSection>
          <BotResponsibilities
            agentId={bot.id}
            sectionTitle="Responsibilities"
          />
        </div>
      ) : (
        <PageEmpty title="No Bot available">
          <Link className="underline underline-offset-4" to="/bots">
            Open Bots
          </Link>{" "}
          to create one or find one shared with you.
        </PageEmpty>
      )}
    </PageShell>
  );
}
