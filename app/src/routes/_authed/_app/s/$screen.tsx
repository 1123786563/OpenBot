import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Navigate,
  redirect,
} from "@tanstack/react-router";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import { BotNeedsYou } from "@/components/needs-you/board";
import { resolveChosenBot, useChosenBotId } from "@/lib/agents/chosen-bot";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";

export const Route = createFileRoute("/_authed/_app/s/$screen")({
  beforeLoad: ({ params }) => {
    if (params.screen === "routines")
      throw redirect({ to: "/routines", replace: true });
    if (params.screen === "tasks")
      throw redirect({ to: "/tasks", replace: true });
    if (params.screen === "memories") {
      throw redirect({ to: "/capabilities/memory", replace: true });
    }
    if (params.screen === "ideas") {
      throw redirect({ to: "/ideas", replace: true });
    }
    if (params.screen === "goals") {
      throw redirect({
        to: "/responsibilities",
        search: { view: "goals" },
        replace: true,
      });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { screen } = Route.useParams();
  return screen === "activity" ? (
    <ActivityOverview />
  ) : (
    <Navigate replace to="/" />
  );
}

function ActivityOverview() {
  const roster = useQuery(agentListQueryOptions());
  const user = useQuery(currentUserQueryOptions());
  const chosenId = useChosenBotId(user.data?.id);
  const bot = resolveChosenBot(roster.data, chosenId);

  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell
        title="Activity"
        description={bot ? `Work for ${bot.name}.` : undefined}
      >
        {roster.isPending || user.isPending ? (
          <p role="status">Loading Activity…</p>
        ) : roster.isError || user.isError ? (
          <p className="text-destructive" role="alert">
            Couldn't load Activity. Reload the page to try again.
          </p>
        ) : bot ? (
          <>
            <Link
              className="underline underline-offset-4"
              params={{ agentId: bot.id }}
              to="/bots/$agentId"
            >
              View {bot.name}
            </Link>
            <BotNeedsYou agentId={bot.id} />
            <BotActivitySections agentId={bot.id} />
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
