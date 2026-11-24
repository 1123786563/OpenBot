import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { useRef } from "react";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { BotScopeSelect } from "@/components/bots/bot-scope-select";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";
import { RoutinesList } from "@/components/routines/routines-list";
import { buttonVariants } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import {
  chooseBot,
  resolveChosenBot,
  useChosenBotId,
} from "@/lib/agents/chosen-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { searchTextEntry } from "@/lib/search-text";

const routinesHeadingId = "bot-goal-routines";

export const Route = createFileRoute("/_authed/_app/responsibilities")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: "goals"; agent?: string; panel?: "routines" } =>
    search.view === "goals"
      ? {
          view: "goals",
          ...searchTextEntry("agent", search.agent),
          ...(search.panel === "routines" ? { panel: "routines" } : {}),
        }
      : {},
  component: ResponsibilitiesPage,
});

function ResponsibilitiesPage() {
  const { view } = Route.useSearch();
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      {view === "goals" ? <GoalsOverview /> : <AllGoals />}
    </AstryxSurface>
  );
}

function AllGoals() {
  const botName = useBotNames();
  return (
    <PageShell
      title="All Bot goals"
      description="Track ongoing work and see which Bot owns each goal."
    >
      <Link
        className={buttonVariants({
          variant: "outline",
          className: "mt-4 min-h-11 self-start",
        })}
        search={{ view: "goals" }}
        to="/responsibilities"
      >
        Goals and routines by Bot
      </Link>
      <BotResponsibilities botName={botName} searchable />
    </PageShell>
  );
}

function GoalsOverview() {
  const { agent, panel } = Route.useSearch();
  const hash = useLocation({ select: (location) => location.hash });
  const showRoutines = panel === "routines" || hash === routinesHeadingId;
  const navigate = Route.useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const user = useQuery(currentUserQueryOptions());
  const selector = useRef<HTMLSelectElement>(null);
  const chosenId = useChosenBotId(user.data?.id);
  const available = agents.data?.filter((bot) => !bot.hidden) ?? [];
  const bot = agent
    ? available.find(({ id }) => id === agent)
    : resolveChosenBot(available, chosenId);

  return (
    <PageShell
      backButton={{
        label: "All Bot goals",
        linkProps: { to: "/responsibilities" },
      }}
      title="Goals and routines by Bot"
    >
      {agents.isPending || user.isPending ? (
        <ReadStatus kind="loading" message="Loading Goals…" />
      ) : agents.isError || user.isError ? (
        <ReadError
          message={
            agents.isError
              ? "Couldn’t load available Bots"
              : "Couldn’t load your account"
          }
          retry={() => Promise.all([agents.refetch(), user.refetch()])}
          retrying={agents.isFetching || user.isFetching}
          retryLabel="Retry loading Bot choices"
          retryBelow
          focusAfterRetry={() => selector.current}
        />
      ) : available.length > 0 ? (
        <>
          <BotScopeSelect
            bots={available}
            selectRef={selector}
            onChange={(id) => {
              if (user.data) chooseBot(user.data.id, id);
              void navigate({
                search: {
                  agent: id,
                  view: "goals",
                  panel: showRoutines ? "routines" : undefined,
                },
                replace: true,
              });
            }}
            value={bot?.id ?? ""}
          />
          {bot ? (
            <WorkForBot bot={bot} key={bot.id} showRoutines={showRoutines} />
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

function WorkForBot({
  bot,
  showRoutines,
}: {
  bot: { id: string; name: string };
  showRoutines: boolean;
}) {
  return (
    <>
      <nav aria-label="Work views" className="mt-4 flex flex-wrap gap-2">
        {(["goals", "routines"] as const).map((view) => {
          const isRoutines = view === "routines";
          const active = showRoutines === isRoutines;
          return (
            <Link
              activeOptions={{ explicitUndefined: true, includeHash: true }}
              aria-current={active ? "page" : undefined}
              className={buttonVariants({
                className: "min-h-11",
                variant: active ? "secondary" : "ghost",
              })}
              key={view}
              search={{
                agent: bot.id,
                panel: isRoutines ? "routines" : undefined,
                view: "goals",
              }}
              to="/responsibilities"
            >
              {isRoutines ? "Routines" : "Goals"}
            </Link>
          );
        })}
      </nav>
      {showRoutines ? (
        <PageSection
          action={
            <Link
              className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
              params={{ agentId: bot.id }}
              to="/bots/$agentId/routines"
            >
              Open routines
            </Link>
          }
          headingId={routinesHeadingId}
          title="Routines"
        >
          <RoutinesList agentId={bot.id} embedded />
        </PageSection>
      ) : (
        <BotResponsibilities
          agentId={bot.id}
          searchable
          sectionTitle={`Goals for ${bot.name}`}
        />
      )}
    </>
  );
}
