import { IconBulb } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  linkOptions,
  redirect,
} from "@tanstack/react-router";
import { AstryxSurface, astryxPilot } from "@/components/astryx-pilot/theme";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { chooseBot, useChosenBotId } from "@/skins/openmuse/chosen-bot";
import { centreBot } from "@/skins/openmuse/model";

export const Route = createFileRoute("/_authed/_app/ideas")({
  beforeLoad: () => {
    if (!astryxPilot)
      throw redirect({
        to: "/s/$screen",
        params: { screen: "ideas" },
        replace: true,
      });
  },
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    typeof search.agent === "string" ? { agent: search.agent } : {},
  component: IdeasPage,
});

function IdeasPage() {
  const { agent } = Route.useSearch();
  const roster = useQuery(agentListQueryOptions());
  const { data: user } = useQuery(currentUserQueryOptions());
  const chosen = useChosenBotId(user?.id);
  const bot = centreBot(roster.data, chosen, agent);
  const navigate = Route.useNavigate();

  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell
        backButton={{ label: "Bots", linkProps: linkOptions({ to: "/bots" }) }}
        description="Review what your Bot found and manage its check-ins."
        title="Ideas"
      >
        {roster.isPending ? (
          <p className="mt-6 text-sm" role="status">
            Loading Bots…
          </p>
        ) : roster.error ? (
          <p className="mt-6 text-destructive text-sm" role="alert">
            {roster.error.message}
          </p>
        ) : bot ? (
          <>
            <label className="mt-6 grid max-w-xs gap-2 text-sm">
              Bot
              <select
                className="w-full rounded-md border border-border bg-background p-2 focus-visible:outline-2 focus-visible:outline-ring"
                onChange={(event) => {
                  const id = event.target.value;
                  if (user) chooseBot(user.id, id);
                  void navigate({ search: { agent: id }, replace: true });
                }}
                value={bot.id}
              >
                {roster.data.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <SuggestionsInbox agentId={bot.id} key={bot.id} showEmpty />
            <ProactiveResearchSettings
              agentId={bot.id}
              key={`settings-${bot.id}`}
              showIdeasLink={false}
            />
          </>
        ) : (
          <PageEmpty icon={IconBulb} title="No Bots yet">
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
