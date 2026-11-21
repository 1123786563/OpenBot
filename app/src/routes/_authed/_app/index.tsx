import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { AgentCard } from "@/components/agents/agent-card";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { WorkingNow } from "@/components/channels/working-now";
import { BusinessLink } from "@/components/edition/business-link";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";
import { firstConversationGreeting } from "@/lib/auth/greeting";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { pendingStartsFor } from "@/lib/channels/pending-start";
import { useSubmitConversationStart } from "@/lib/channels/start";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { editionOf } from "@/lib/edition-guard";
import { useAnyBotSkillCommands } from "@/lib/plugins/skill-commands";

/** How many Bots the home page shows before pointing to the rest. Two rows of two. */
const EXPLORE_SHOWN = 4;

export const Route = createFileRoute("/_authed/_app/")({
  /*
   * `ask`: words to start the box with, as Teach a Bot's Try it hands over a task a Bot just learned. Only put in the
   * box: nothing is sent until the person sends it.
   */
  validateSearch: z.object({ ask: z.string().max(2000).optional() }),
  // The edition decides whether there is an Explore section at all, so it is read before the page draws and the
  // composer never moves when it arrives.
  beforeLoad: async ({ context }) => {
    await editionOf(context.queryClient);
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const {
    data: agents,
    isPending: loading,
    isError: failed,
  } = useQuery(agentListQueryOptions());
  const explore = agents?.filter(isSharedWithYou);
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  /*
   * The personal edition has nobody to share a Bot with. Its Explore lists the Bots included with
   * OpenBot, and when there are none it shows nothing: "Nobody has shared a Bot with you yet" was
   * not true of it. A Bots list that fails to load is said under the composer already.
   */
  const personal = capabilities.data?.edition === "personal";
  const { submit, error: saveError } = useSubmitConversationStart(user?.id);
  const savedStarts = user ? pendingStartsFor(user.id) : [];
  const ask = useSearch({ strict: false }).ask;
  const [asked] = useState(ask);

  /** Default recipient when the composer draft has no mention. */
  /*
   * Every skill any of the person's Bots offers. The Bot is not known until it is chosen with `@` or
   * routed to after sending, so the menu offers them all and sending picks a Bot that has the one
   * used. Without this the box fell back to a placeholder command no Bot has.
   */
  const { commands: skillCommands } = useAnyBotSkillCommands(
    agents?.map((agent) => agent.id) ?? [],
  );
  const fallback = defaultAgentProfile(
    agents,
    agents?.find((agent) => agent.visibility === "public"),
  );

  return (
    <>
      <SidebarToggleBar>
        <BusinessLink />
      </SidebarToggleBar>
      <div className="flex-1 flex flex-col items-center justify-center w-full p-4 mt-8">
        {/* No product-name label above the greeting: the sidebar already names the product, and a
            second heading over the first made the page open on a word that says nothing. */}
        <div className="flex flex-col items-center">
          <h1 className="text-2xl font-semibold tracking-tight text-center">
            {firstConversationGreeting(
              user,
              channels.isSuccess && channels.data.length === 0,
            )}
          </h1>
        </div>
        <div className="mt-8 w-full flex flex-col items-center">
          {savedStarts.length > 0 ? (
            <ul className="mb-3 w-full max-w-2xl space-y-1">
              {savedStarts.map(({ id, start }) => (
                <li key={id} className="min-w-0">
                  <Link
                    className="block truncate text-sm underline"
                    params={{ startId: id }}
                    to="/start/$startId"
                  >
                    Resume conversation · {start.draft.text || "Attachment"}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <StarterSuggestions
            agentId={fallback?.id}
            onSelect={async (message) => {
              if (!fallback) return;
              await submit(
                {
                  text: message,
                  commandIds: [],
                  attachments: [],
                  agentId: fallback.id,
                  isEmpty: false,
                },
                { kind: "direct", agentId: fallback.id },
              );
            }}
          />
          <Composer
            agents={toAgentOptions(agents)}
            commands={skillCommands}
            className="w-full max-w-2xl"
            disabled={!fallback}
            {...(asked ? { initialValue: asked, autoFocus: true } : {})}
            onSubmit={(draft) =>
              submit(
                draft,
                draft.agentId
                  ? { kind: "direct", agentId: draft.agentId }
                  : { kind: "route", fallbackId: fallback?.id },
              )
            }
          />
          {fallback ? (
            // Said out loud: a message that silently reaches somebody you did not choose is the
            // kind of surprise that costs trust the first time it happens.
            <p className="mt-2 w-full max-w-2xl text-xs text-muted-foreground text-center">
              OpenBot picks the right Bot. Type <code>@</code> to choose one.
            </p>
          ) : null}
          {saveError ? (
            <p
              className="mt-2 w-full max-w-2xl text-sm text-destructive"
              role="alert"
            >
              {saveError}
            </p>
          ) : null}
          {failed && agents === undefined ? (
            // The composer above is `disabled={!fallback}`, and a failed query does not by
            // itself mean `fallback` is undefined: TanStack Query keeps its last good `data`
            // across a failed background refetch, and `!fallback` alone is also true of a query
            // that loaded successfully and genuinely returned zero agents — a case where nobody
            // failed to load anything. `agents === undefined` is the one condition that is only
            // true when the query has never once returned successfully, so this alert can only
            // ever claim a load failure while that is actually what happened.
            <p
              className="mt-2 w-full max-w-2xl text-sm text-destructive"
              role="alert"
            >
              Couldn't load your Bots, so there's no one to send this to. Reload
              the page.
            </p>
          ) : null}
        </div>
        {/*
         * Up to four Bots, two to a row, as compact cards that fill the column. A teaser under the
         * composer, not the place to browse: more than four would push the composer up every time
         * somebody shared another Bot, so the rest are one "All Bots" away. Every state below
         * reserves the same two rows, so the composer above it does not move when the list settles.
         */}
        <div className="mt-10 w-full max-w-2xl">
          {loading || capabilities.isPending ? (
            <>
              <h2 className="font-semibold text-base">Explore Bots</h2>
              <Skeleton className="mt-4 h-[140px]" />
            </>
          ) : explore?.length ? (
            // Wins over `failed`: a failed background refetch does not clear TanStack Query's
            // cached `data`, so a stale list here beats an error card claiming there is
            // nothing to explore, which would be false while this list is still populated.
            <section aria-labelledby="explore-agents-heading">
              <div className="flex flex-row items-center justify-between gap-4">
                <h2
                  id="explore-agents-heading"
                  className="font-semibold text-base"
                >
                  Explore Bots
                </h2>
                {explore.length > EXPLORE_SHOWN ? (
                  <Link
                    className="text-muted-foreground text-sm hover:text-foreground"
                    to="/bots"
                  >
                    All Bots
                  </Link>
                ) : null}
              </div>
              <ul className="mt-4 grid min-h-[140px] grid-cols-1 content-start gap-3 sm:grid-cols-2">
                {explore.slice(0, EXPLORE_SHOWN).map((agent) => (
                  <li className="min-w-0" key={agent.id}>
                    <Link search={{ agent: agent.id }} to="/channel/new">
                      <AgentCard agent={agent} appearance="row" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : personal ? null : failed && agents === undefined ? (
            // `agents === undefined` narrows this to "the query has never once returned
            // successfully" — not merely "the last request errored". `?.length` alone can't
            // tell that apart from a slice that loaded and is genuinely empty: TanStack Query
            // never clears `data` on a failed background refetch, so once the query has
            // resolved even one response, `agents` stays defined and `explore`'s emptiness is a
            // fact about that response, not a symptom of the failure. Rendering the destructive
            // card there would say the opposite of what a populated composer beside it (still
            // working off that same, successfully loaded `agents`) proves.
            <>
              <h2 className="font-semibold text-base">Explore Bots</h2>
              <Empty className="mt-4 h-[140px] border border-dashed border-destructive">
                <EmptyHeader>
                  <EmptyTitle className="text-destructive">
                    Couldn't load the Bots shared with you.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            </>
          ) : (
            // Reached both when the query never failed and `explore` is genuinely empty, and
            // when it failed but `agents` is defined — a loaded, empty slice either way. Same
            // plain copy for both: an empty roster is a fact, not an error.
            <>
              <h2 className="font-semibold text-base">Explore Bots</h2>
              <Empty className="mt-4 h-[140px] border border-dashed">
                <EmptyHeader>
                  <EmptyTitle className="text-muted-foreground">
                    Nobody has shared a Bot with you yet.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            </>
          )}
        </div>
      </div>
      {/* A Bot already working somewhere, and the way to it. Nothing while every Bot is idle. */}
      <WorkingNow channels={channels.data} />
    </>
  );
}
