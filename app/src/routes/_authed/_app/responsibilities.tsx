import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { BotScopeSelect } from "@/components/bots/bot-scope-select";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadStatus } from "@/components/layout/read-status";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { RoutinesList } from "@/components/routines/routines-list";
import {
  chooseBot,
  resolveChosenBot,
  useChosenBotId,
} from "@/lib/agents/chosen-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { searchTextEntry } from "@/lib/search-text";

export const Route = createFileRoute("/_authed/_app/responsibilities")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: "goals"; agent?: string } =>
    search.view === "goals"
      ? { view: "goals", ...searchTextEntry("agent", search.agent) }
      : {},
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
          description="Review ongoing work across your Bots."
          title="Responsibilities"
        >
          <BotResponsibilities />
        </PageShell>
      )}
    </AstryxSurface>
  );
}

function GoalsOverview() {
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const user = useQuery(currentUserQueryOptions());
  const chosenId = useChosenBotId(user.data?.id);
  const available = agents.data?.filter((bot) => !bot.hidden) ?? [];
  const bot = agent
    ? available.find(({ id }) => id === agent)
    : resolveChosenBot(available, chosenId);

  return (
    <PageShell
      title="Goals"
      description={bot ? `Review ongoing work for ${bot.name}.` : undefined}
    >
      {agents.isPending || user.isPending ? (
        <ReadStatus kind="loading" message="Loading Goals…" />
      ) : agents.isError || user.isError ? (
        <ReadStatus
          kind="error"
          message="Couldn’t load your Goals"
          retry={() => Promise.all([agents.refetch(), user.refetch()])}
        />
      ) : available.length > 0 ? (
        <>
          <BotScopeSelect
            bots={available}
            onChange={(id) => {
              if (user.data) chooseBot(user.data.id, id);
              void navigate({
                search: { agent: id, view: "goals" },
                replace: true,
              });
            }}
            value={bot?.id ?? ""}
          />
          {bot ? (
            <GoalsForBot bot={bot} key={bot.id} />
          ) : (
            <PageEmpty title="This Bot is unavailable">
              Choose another Bot to see its goals.
            </PageEmpty>
          )}
        </>
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

function GoalsForBot({ bot }: { bot: { id: string; name: string } }) {
  return (
    <>
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
        <Link className="underline underline-offset-4" to="/responsibilities">
          All responsibilities
        </Link>
      </nav>
      <BotResponsibilities agentId={bot.id} sectionTitle="Goals for this Bot" />
      <PageSection title="Routines">
        <RoutinesList agentId={bot.id} embedded />
      </PageSection>
    </>
  );
}
