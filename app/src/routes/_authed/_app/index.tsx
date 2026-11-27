import { Popover } from "@astryxdesign/core/Popover";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { LinkProvider } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/VStack";
import { IconArrowUpRight, IconCpu, IconFileText } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  isSegmentsEmpty,
  type Segment,
  segmentsToPlainText,
  text,
} from "prompt-area/helpers";
import { useCallback, useRef, useState } from "react";
import { z } from "zod";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { toDraft } from "@/components/channels/composer/draft";
import { ModelPicker } from "@/components/channels/composer/model-picker";
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
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { useDraftModel } from "@/lib/models/run-model";
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
  const [mentionedBot, setMentionedBot] = useState<string | null>();
  const trackDraft = useCallback((segments: Segment[]) => {
    currentDraft.current = segments;
    setMentionedBot(toDraft(segments).agentId);
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
  // An automatically routed request can use a pick only when every candidate accepts it.
  const canPickModel = (agentId?: string | null) =>
    agentId
      ? (agents?.some(
          (agent) => agent.id === agentId && agent.runsOnOpenBotModel === true,
        ) ?? false)
      : Boolean(
          agents?.length &&
            agents.every((agent) => agent.runsOnOpenBotModel === true),
        );
  const pickable = canPickModel(mentionedBot);
  const models = useQuery({
    ...modelCatalogueQueryOptions(),
    enabled: pickable,
  });
  const catalogue = pickable ? models.data : undefined;
  const draftModel = useDraftModel(catalogue);
  const defaultModel = catalogue?.models.find(
    (model) => model.id === catalogue.default,
  );

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
      <VStack className="astryx-chat-home min-h-0 flex-1" isScrollable>
        <VStack
          className="mx-auto my-auto shrink-0 px-4 py-8"
          gap={8}
          maxWidth="44rem"
          width="100%"
        >
          <VStack as="section" aria-labelledby="home-compose-heading" gap={4}>
            <Heading
              id="home-compose-heading"
              justify="center"
              level={1}
              textWrap="balance"
              weight="semibold"
            >
              {firstConversationGreeting(
                user,
                channels.isSuccess && channels.data.length === 0,
              )}
            </Heading>
            <Composer
              allowFirstMessageAttachments
              key={messageKey}
              draftStorageKey={messageKey}
              onDraftChange={trackDraft}
              agents={toAgentOptions(agents)}
              commands={skillCommands}
              className="astryx-home-composer w-full min-w-0"
              editorClassName="text-base"
              modelPicker={
                catalogue?.choosable && draftModel.value ? (
                  <ModelPicker
                    catalogue={catalogue}
                    value={draftModel.value}
                    onChange={draftModel.choose}
                  />
                ) : (
                  <Popover
                    label="Conversation model"
                    placement="above"
                    content={
                      <VStack gap={2} maxWidth="16rem">
                        <Text weight="semibold">
                          {defaultModel?.label ?? "Automatic model"}
                        </Text>
                        <Text type="supporting">
                          {!pickable
                            ? "The receiving Bot determines the model. Use @ to choose a Bot that supports model selection."
                            : models.isPending
                              ? "Loading models…"
                              : defaultModel
                                ? "Only the default model is currently available."
                                : "The model list is currently unavailable."}
                        </Text>
                        {pickable && !models.isPending ? (
                          <Button
                            label="Refresh models"
                            size="sm"
                            variant="ghost"
                            type="button"
                            isLoading={models.isFetching}
                            onClick={() => void models.refetch()}
                          />
                        ) : null}
                      </VStack>
                    }
                  >
                    <Button
                      label={`Model: ${defaultModel?.label ?? "Automatic"}`}
                      icon={<IconCpu aria-hidden />}
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      type="button"
                    />
                  </Popover>
                )
              }
              disabled={!fallback}
              {...(asked ? { initialValue: asked, autoFocus: true } : {})}
              onSubmit={(draft) =>
                submit(
                  draft,
                  draft.agentId
                    ? { kind: "direct", agentId: draft.agentId }
                    : { kind: "route", fallbackId: fallback?.id },
                  canPickModel(draft.agentId) ? draftModel.requested : null,
                  () => writeComposeDraft(messageKey),
                )
              }
            />
            {fallback ? (
              <VStack gap={1} align="center">
                <Text type="supporting" className="text-center">
                  OpenBot picks a Bot for you. Type <code>@</code> to choose
                  one.
                </Text>
                <Button
                  label="Choose Bots for a new conversation"
                  size="sm"
                  variant="ghost"
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
                    if (
                      draftModel.requested &&
                      addressedBot?.runsOnOpenBotModel
                    ) {
                      writeComposeDraft(
                        composeDraftKey(user?.id, newConversation, "model"),
                        draftModel.requested,
                      );
                    }
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
                  canPickModel(fallback.id) ? draftModel.requested : null,
                );
              }}
            />
          </VStack>

          {savedStarts.length > 0 ? (
            <section aria-labelledby="saved-starts-heading">
              <VStack gap={2}>
                <h2
                  id="saved-starts-heading"
                  className="text-base font-semibold"
                >
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
                <Heading
                  id="explore-agents-heading"
                  level={5}
                  accessibilityLevel={2}
                >
                  Explore Bots
                </Heading>
                {explore.length ? (
                  <Grid columns={{ minWidth: 240, max: 2 }} gap={3}>
                    {explore.slice(0, EXPLORE_SHOWN).map((agent) => (
                      <Link
                        className="astryx-home-bot"
                        key={agent.id}
                        to="/channel/new"
                        search={{ agent: agent.id }}
                      >
                        <HStack align="center" gap={3}>
                          <ChannelAvatar
                            participantIds={[agent.id]}
                            size={32}
                          />
                          <VStack className="min-w-0" gap={0.5}>
                            <Text type="label" maxLines={1}>
                              {agent.name}
                            </Text>
                            {agent.title ? (
                              <Text type="supporting" maxLines={1}>
                                {agent.title}
                              </Text>
                            ) : null}
                          </VStack>
                        </HStack>
                      </Link>
                    ))}
                  </Grid>
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
      </VStack>
    </LinkProvider>
  );
}
