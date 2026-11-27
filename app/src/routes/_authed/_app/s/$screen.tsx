import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useRef } from "react";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { BotScopeSelect } from "@/components/bots/bot-scope-select";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { MissingPage } from "@/components/layout/route-recovery";
import { BotNeedsYou } from "@/components/needs-you/board";
import { useTranslation } from "@/i18n";
import {
  chooseBot,
  resolveChosenBot,
  useChosenBotId,
} from "@/lib/agents/chosen-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { searchTextEntry } from "@/lib/search-text";

export const Route = createFileRoute("/_authed/_app/s/$screen")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    searchTextEntry("agent", search.agent),
  beforeLoad: ({ params, search }) => {
    if (params.screen === "routines")
      throw redirect({ to: "/routines", replace: true });
    if (params.screen === "tasks")
      throw redirect({ to: "/tasks", replace: true });
    if (params.screen === "memories") {
      throw redirect({ to: "/capabilities/memory", replace: true });
    }
    if (params.screen === "ideas") {
      throw redirect({ to: "/ideas", search, replace: true });
    }
    if (params.screen === "goals") {
      throw redirect({
        to: "/responsibilities",
        search: { ...search, view: "goals" },
        replace: true,
      });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { screen } = Route.useParams();
  return screen === "activity" ? <ActivityOverview /> : <MissingPage />;
}

function ActivityOverview() {
  const { t } = useTranslation();
  const selector = useRef<HTMLSelectElement>(null);
  const { agent } = Route.useSearch();
  const navigate = Route.useNavigate();
  const roster = useQuery(agentListQueryOptions());
  const user = useQuery(currentUserQueryOptions());
  const chosenId = useChosenBotId(user.data?.id);
  const available = roster.data?.filter((bot) => !bot.hidden) ?? [];
  const bot = agent
    ? available.find(({ id }) => id === agent)
    : resolveChosenBot(available, chosenId);

  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell
        title="Activity"
        description={bot ? `Review activity for ${bot.name}.` : undefined}
      >
        {roster.isPending || user.isPending ? (
          <ReadStatus kind="loading" message="Loading Activity…" />
        ) : roster.isError || user.isError ? (
          <ReadError
            focusAfterRetry={() => selector.current}
            message="Couldn’t load Activity"
            retry={() => Promise.all([roster.refetch(), user.refetch()])}
            retryBelow
            retryLabel={t("bots.retryChoices", "Retry loading Bot choices")}
            retrying={roster.isFetching || user.isFetching}
          />
        ) : available.length > 0 ? (
          <>
            <BotScopeSelect
              bots={available}
              onChange={(id) => {
                if (user.data) chooseBot(user.data.id, id);
                void navigate({ search: { agent: id }, replace: true });
              }}
              selectRef={selector}
              value={bot?.id ?? ""}
            />
            {bot ? (
              <ActivityForBot bot={bot} key={bot.id} />
            ) : (
              <PageEmpty title="This Bot is unavailable">
                Choose another Bot to see its activity.
              </PageEmpty>
            )}
          </>
        ) : (
          <PageEmpty title="No Bots yet">
            <Link className="underline underline-offset-4" to="/bots">
              Open Bots
            </Link>
          </PageEmpty>
        )}
      </PageShell>
    </AstryxSurface>
  );
}

function ActivityForBot({ bot }: { bot: { id: string; name: string } }) {
  return (
    <>
      <Link
        className="mt-4 text-sm underline underline-offset-4"
        params={{ agentId: bot.id }}
        to="/bots/$agentId"
      >
        View {bot.name}
      </Link>
      <BotNeedsYou agentId={bot.id} />
      <BotActivitySections agentId={bot.id} />
    </>
  );
}
