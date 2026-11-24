import { IconBulb } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, linkOptions } from "@tanstack/react-router";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { BotScopeSelect } from "@/components/bots/bot-scope-select";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { ReadStatus } from "@/components/layout/read-status";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import {
  chooseBot,
  resolveChosenBot,
  useChosenBotId,
} from "@/lib/agents/chosen-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { searchTextEntry } from "@/lib/search-text";

export const Route = createFileRoute("/_authed/_app/ideas")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    searchTextEntry("agent", search.agent),
  component: IdeasPage,
});

function IdeasPage() {
  const { agent } = Route.useSearch();
  const roster = useQuery(agentListQueryOptions());
  const { data: user } = useQuery(currentUserQueryOptions());
  const chosen = useChosenBotId(user?.id);
  const available = roster.data?.filter(({ hidden }) => !hidden) ?? [];
  const bot = agent
    ? available.find(({ id }) => id === agent)
    : resolveChosenBot(available, chosen);
  const navigate = Route.useNavigate();

  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell
        backButton={{ label: "Bots", linkProps: linkOptions({ to: "/bots" }) }}
        description="Review what your Bot found and manage its check-ins."
        title="Ideas"
      >
        {roster.isPending ? (
          <ReadStatus kind="loading" message="Loading Bots…" />
        ) : roster.error ? (
          <ReadStatus
            kind="error"
            message="Couldn’t load your Bots"
            retry={roster.refetch}
          />
        ) : available.length > 0 ? (
          <>
            <BotScopeSelect
              bots={available}
              onChange={(id) => {
                if (user) chooseBot(user.id, id);
                void navigate({ search: { agent: id }, replace: true });
              }}
              value={bot?.id ?? ""}
            />
            {bot ? (
              <>
                <SuggestionsInbox
                  agentId={bot.id}
                  key={bot.id}
                  searchable
                  showEmpty
                />
                <ProactiveResearchSettings
                  agentId={bot.id}
                  key={`settings-${bot.id}`}
                  showIdeasLink={false}
                />
              </>
            ) : (
              <PageEmpty icon={IconBulb} title="This Bot is unavailable">
                Choose a Bot to see its ideas and check-ins.
              </PageEmpty>
            )}
          </>
        ) : (
          <PageEmpty
            icon={IconBulb}
            title={roster.data?.length ? "No Bots available" : "No Bots yet"}
          >
            <Link
              className="underline underline-offset-4"
              search={{ new: true }}
              to="/bots"
            >
              Create a Bot
            </Link>{" "}
            to get started.
          </PageEmpty>
        )}
      </PageShell>
    </AstryxSurface>
  );
}
