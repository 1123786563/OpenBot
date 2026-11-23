import { Button } from "@astryxdesign/core/Button";
import { LinkProvider } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/VStack";
import { IconArrowUpRight, IconFileText } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  isSegmentsEmpty,
  type Segment,
  segmentsToPlainText,
  text,
} from "prompt-area/helpers";
import { useCallback, useRef } from "react";
import { z } from "zod";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { toDraft } from "@/components/channels/composer/draft";
import { WorkingNow } from "@/components/channels/working-now";
import { BusinessLink } from "@/components/edition/business-link";
import { ReadStatus } from "@/components/layout/read-status";
import { StarterSuggestions } from "@/components/starter-tour/starter-suggestions";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import { agentListQueryOptions, isSharedWithYou } from "@/lib/agents/queries";
import { firstConversationGreeting } from "@/lib/auth/greeting";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  composeDraftKey,
  writeComposeDraft,
} from "@/lib/channels/compose-draft";
import { pendingStartsFor } from "@/lib/channels/pending-start";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useSubmitConversationStart } from "@/lib/channels/start";
import { ClientError } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { editionOf } from "@/lib/edition-guard";
import { newId } from "@/lib/new-id";
import { useAnyBotSkillCommands } from "@/lib/plugins/skill-commands";

/** How many Bots the home page shows before pointing to the rest. */
const EXPLORE_SHOWN = 4;

export const Route = createFileRoute("/_authed/_app/")({
  /*
   * `ask`: words to start the box with, as Teach a Bot's Try it hands over a task a Bot just learned. Only put in the
   * box: nothing is sent until the person sends it.
   */
  validateSearch: z.object({ ask: z.string().max(2000).optional() }),
  beforeLoad: async ({ context }) => {
    await editionOf(context.queryClient);
  },
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = Route.useNavigate();
  const currentDraft = useRef<Segment[]>([]);
  const trackDraft = useCallback((segments: Segment[]) => {
    currentDraft.current = segments;
  }, []);
  const { data: user } = useQuery(currentUserQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const roster = useQuery(agentListQueryOptions());
  const agents = roster.data;
  const explore = agents?.filter(isSharedWithYou) ?? [];
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const denied =
    roster.error instanceof ClientError && roster.error.status === 403;
  const { submit, error: saveError } = useSubmitConversationStart(user?.id);
  const { ask: asked } = Route.useSearch();
  const messageKey = composeDraftKey(
    user?.id,
    asked ? `home-ask:${encodeURIComponent(asked)}` : "home",
    "message",
  );
  const savedStarts = user ? pendingStartsFor(user.id) : [];

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
    <LinkProvider component={Link}>
      <VStack
        gap={6}
        maxWidth="48rem"
        width="100%"
        style={{
          marginInline: "auto",
          paddingInline: "var(--spacing-4)",
          paddingBlock: "var(--spacing-6)",
        }}
      >
        <section aria-labelledby="home-compose-heading">
          <VStack gap={3}>
            <h1
              id="home-compose-heading"
              className="text-2xl font-semibold tracking-tight"
              style={{ textWrap: "balance", overflowWrap: "anywhere" }}
            >
              {firstConversationGreeting(
                user,
                channels.isSuccess && channels.data.length === 0,
              )}
            </h1>
            <Composer
              key={messageKey}
              draftStorageKey={messageKey}
              onDraftChange={trackDraft}
              agents={toAgentOptions(agents)}
              commands={skillCommands}
              className="w-full min-w-0"
              disabled={!fallback}
              {...(asked ? { initialValue: asked, autoFocus: true } : {})}
              onSubmit={(draft) =>
                submit(
                  draft,
                  draft.agentId
                    ? { kind: "direct", agentId: draft.agentId }
                    : { kind: "route", fallbackId: fallback?.id },
                  null,
                  () => writeComposeDraft(messageKey),
                )
              }
            />
            {fallback ? (
              <VStack gap={1} align="start">
                <p className="text-sm text-muted-foreground">
                  OpenBot picks a Bot for you. Type <code>@</code> to choose one
                  here.
                </p>
                <Button
                  label="Choose Bots for a new conversation"
                  size="sm"
                  variant="secondary"
                  className="max-md:min-h-11 pointer-coarse:min-h-11"
                  isDisabled={!user}
                  onClick={() => {
                    const draft = currentDraft.current;
                    if (isSegmentsEmpty(draft)) {
                      void navigate({ to: "/channel/new" });
                      return;
                    }
                    const newConversation = newId();
                    const destination = composeDraftKey(
                      user?.id,
                      newConversation,
                      "message",
                    );
                    const { agentId } = toDraft(draft);
                    const addressedBot = agents?.find(
                      ({ id }) => id === agentId,
                    );
                    const message = segmentsToPlainText(draft);
                    writeComposeDraft(destination, [text(message)]);
                    void navigate({
                      to: "/channel/new",
                      search: addressedBot ? { agent: addressedBot.id } : {},
                      state: { newConversation, copiedFromHome: true },
                    });
                  }}
                />
              </VStack>
            ) : roster.isPending ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading your Bots…
              </p>
            ) : denied ? (
              <p className="text-sm text-destructive" role="alert">
                You don’t have access to the Bots in this workspace. Ask a
                workspace administrator for access.
              </p>
            ) : agents === undefined ? (
              <ReadStatus
                kind="error"
                message="Couldn’t load your Bots."
                retry={() => roster.refetch()}
              />
            ) : (
              <p className="text-sm">
                No Bots are available yet.{" "}
                <Link
                  to="/bots"
                  style={{
                    textDecoration: "underline",
                    textUnderlineOffset: "0.15em",
                  }}
                >
                  Browse Bots
                </Link>
              </p>
            )}
            {saveError ? (
              <p className="text-sm text-destructive" role="alert">
                {saveError}
              </p>
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
          </VStack>
        </section>

        {savedStarts.length > 0 ? (
          <section aria-labelledby="saved-starts-heading">
            <VStack gap={2}>
              <h2 id="saved-starts-heading" className="text-base font-semibold">
                Resume a conversation
              </h2>
              <List density="balanced" hasDividers>
                {savedStarts.map(({ id, start }) => (
                  <ListItem
                    key={id}
                    href={`/start/${encodeURIComponent(id)}`}
                    label={
                      start.draft.text ||
                      start.draft.attachments[0]?.name ||
                      "Attachment"
                    }
                    description="Resume sending"
                    startContent={
                      <IconFileText aria-hidden="true" size="1.25rem" />
                    }
                    endContent={
                      <IconArrowUpRight aria-hidden="true" size="1rem" />
                    }
                  />
                ))}
              </List>
            </VStack>
          </section>
        ) : null}

        <WorkingNow channels={channels.data} />

        {explore.length > 0 || (!personal && Boolean(agents?.length)) ? (
          <section aria-labelledby="explore-agents-heading">
            <VStack gap={2}>
              <h2
                id="explore-agents-heading"
                className="text-base font-semibold"
              >
                Explore Bots
              </h2>
              {explore.length ? (
                <List density="balanced" hasDividers>
                  {explore.slice(0, EXPLORE_SHOWN).map((agent) => (
                    <ListItem
                      key={agent.id}
                      href={`/channel/new?agent=${encodeURIComponent(agent.id)}`}
                      label={agent.name}
                      description={agent.title || undefined}
                      startContent={
                        <ChannelAvatar participantIds={[agent.id]} size={28} />
                      }
                      endContent={
                        <IconArrowUpRight aria-hidden="true" size="1rem" />
                      }
                    />
                  ))}
                </List>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nobody has shared a Bot with you yet.
                </p>
              )}
              {agents?.length ? (
                <Link
                  className="text-sm"
                  style={{
                    textDecoration: "underline",
                    textUnderlineOffset: "0.15em",
                  }}
                  to="/bots"
                >
                  All Bots
                </Link>
              ) : null}
            </VStack>
          </section>
        ) : null}
        <BusinessLink />
      </VStack>
    </LinkProvider>
  );
}
