import { Banner } from "@astryxdesign/core/Banner";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { z } from "zod";
import { ConversationApprovals } from "@/components/approvals/inline-approval";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { BotChatView } from "@/components/channels/bot-chat-view";
import {
  ConversationLoading,
  ConversationReadError,
} from "@/components/channels/conversation-status";
import { ConversationSurface } from "@/components/channels/conversation-surface";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";
import {
  defaultAgentId,
  defaultAgentProfile,
} from "@/lib/agents/default-agent";
import { agentKeys, agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  composeDraftKey,
  draftSegments,
  readComposeDraft,
  writeComposeDraft,
} from "@/lib/channels/compose-draft";
import { tryClient } from "@/lib/client";
import { useOpenComputerOnRequest } from "@/lib/computers/panel-view";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useBotActivity } from "@/lib/copilot/bot-activity";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { modelCatalogueQueryOptions } from "@/lib/models/queries";
import { searchTextEntry } from "@/lib/search-text";

const quickDraftText = z.string();

/**
 * The composer keeps a draft as segments (text and `/` chips); the packaged chat kept plain text
 * under the same key. A draft written before this screen moved over is read once, in the older shape,
 * and put back in the one the composer reads, or the first thing typed here wipes it.
 */
function keepEarlierDraft(key: string | undefined) {
  const earlier = readComposeDraft(key, quickDraftText);
  if (earlier) writeComposeDraft(key, [{ type: "text", text: earlier }]);
}

function hasDraft(key: string | undefined) {
  return Boolean(
    readComposeDraft(key, quickDraftText)?.trim() ??
      readComposeDraft(key, draftSegments)?.some(
        (segment) => segment.type !== "text" || segment.text.trim(),
      ),
  );
}

export const Route = createFileRoute("/_authed/_app/bot")({
  component: RouteComponent,
  /*
   * `?agent=` is read as text whatever the router parsed it into (`searchText`), because search
   * values are JSON-parsed and a Bot id made of digits would otherwise arrive as a number and open
   * this deployment's default Bot rather than the named one. `?watch=` is a flag and is read as the
   * boolean it is parsed into: anything else is not the flag being set.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; watch?: boolean } => ({
    ...searchTextEntry("agent", search.agent),
    ...(search.watch === true ? { watch: true } : {}),
  }),
});

/**
 * Which Bot this screen is for.
 *
 * WHATEVER THIS DEPLOYMENT ACTUALLY HAS. The default used to be a hardcoded `risk-analyst`, a name
 * from a tenant package this one is not: on a clone that ships anything else, opening this screen
 * without naming a Bot took the whole page down to an unstyled error boundary, because the chat
 * throws when asked for an agent the runtime never synced. OpenBot exists to be forked, so a Bot
 * name written into a route is a defect on every fork but the one it came from.
 *
 * A named Bot that this deployment does not have is answered in a sentence rather than thrown,
 * for the same reason: a mistyped link is not a crash.
 */
const quickBotEnvelope = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    roleDescription: z.string().nullish(),
    runsOnOpenBotModel: z.boolean().optional(),
    visibility: z.enum(["public", "private"]),
  }),
});
type BotDetailLookup =
  | { bot: z.infer<typeof quickBotEnvelope>["agent"]; status: "found" }
  | { status: "missing" }
  | { status: "denied" };
const quickBotRecoveryTarget = () =>
  document.getElementById("quick-chat-title") ??
  document.getElementById("quick-chat-browse-bots");

async function loadExplicitBot(
  agentId: string,
  signal: AbortSignal,
): Promise<BotDetailLookup> {
  const response = await tryClient(
    `/api/agents/${encodeURIComponent(agentId)}`,
    { signal },
  );
  if (response.status === 404) return { status: "missing" };
  if (response.status === 401 || response.status === 403)
    return { status: "denied" };
  if (!response.ok) throw new Error("Couldn't load this Bot.");

  const result = quickBotEnvelope.safeParse(
    await response.json().catch(() => null),
  );
  if (!result.success || result.data.agent.id !== agentId)
    throw new Error("Couldn't load this Bot.");
  return { bot: result.data.agent, status: "found" };
}

function QuickChatRecoveryLinks({
  alternative,
}: {
  alternative?: { id: string; name: string };
}) {
  const className = buttonVariants({
    className: "conversation-recovery-action",
    variant: "outline",
  });
  return (
    <Stack direction="horizontal" gap={2} wrap="wrap">
      {alternative ? (
        <Link
          className={className}
          search={{ agent: alternative.id }}
          style={{
            blockSize: "auto",
            maxInlineSize: "100%",
            overflowWrap: "anywhere",
            textAlign: "start",
            whiteSpace: "normal",
          }}
          to="/bot"
        >
          Open {alternative.name}
        </Link>
      ) : null}
      <Link className={className} id="quick-chat-browse-bots" to="/bots">
        Browse Bots
      </Link>
    </Stack>
  );
}

function RouteComponent() {
  const search = Route.useSearch();
  const { data: user } = useQuery(currentUserQueryOptions());
  const agent = search.agent === "" ? undefined : search.agent;
  const {
    data: agents,
    isError,
    isPending,
    isFetching,
    refetch,
  } = useQuery(agentListQueryOptions());
  const agentId = agent ?? defaultAgentId(agents);
  const draftKey = agentId
    ? composeDraftKey(
        user?.id,
        `quick:${encodeURIComponent(agentId)}`,
        "message",
      )
    : undefined;
  const alternative =
    agent && !isError
      ? defaultAgentProfile(
          agents?.filter((candidate) => candidate.id !== agent),
        )
      : undefined;
  const listedBot = isError
    ? undefined
    : agents?.find((candidate) => candidate.id === agentId);
  const detailAgentId = agent ?? "";
  const shouldLoadExplicitBot = Boolean(agent) && listedBot === undefined;
  const {
    data: detail,
    isError: isDetailError,
    isPending: isDetailPending,
    isFetching: isDetailFetching,
    refetch: refetchDetail,
  } = useQuery({
    enabled: shouldLoadExplicitBot,
    queryKey: agentKeys.botRouteDetail(detailAgentId),
    queryFn: ({ signal }) => loadExplicitBot(detailAgentId, signal),
    retry: false,
  });
  const bot =
    listedBot ?? (detail?.status === "found" ? detail.bot : undefined);

  if ((!agent && isPending) || (shouldLoadExplicitBot && isDetailPending)) {
    return <ConversationLoading label="Finding your Bot…" />;
  }
  if (!agent && isError) {
    return (
      <Stack gap={3} style={{ padding: "var(--spacing-4, 1rem)" }}>
        <ConversationReadError
          title="Couldn't load your Bots."
          focusAfterRetry={quickBotRecoveryTarget}
          retryBelow
          retryLabel="Retry Bot list"
          retry={() => void refetch()}
          retrying={isFetching}
        />
        <QuickChatRecoveryLinks />
      </Stack>
    );
  }
  if (shouldLoadExplicitBot && isDetailError) {
    return (
      <Stack gap={3} style={{ padding: "var(--spacing-4, 1rem)" }}>
        <ConversationReadError
          description={
            hasDraft(draftKey)
              ? "Your unsent message stays with this Bot in this tab."
              : undefined
          }
          title="Couldn't load this Bot."
          focusAfterRetry={quickBotRecoveryTarget}
          retryBelow
          retryLabel="Retry this Bot"
          retry={() => void refetchDetail()}
          retrying={isDetailFetching}
        />
        <QuickChatRecoveryLinks alternative={alternative} />
      </Stack>
    );
  }
  if (!agentId || !bot) {
    return (
      <Stack style={{ padding: "var(--spacing-4, 1rem)" }}>
        <Banner
          collapsible={false}
          status="info"
          title={
            detail?.status === "denied"
              ? "This Bot is unavailable to you."
              : agent
                ? "We couldn't find this Bot."
                : "There are no Bots yet."
          }
        >
          <QuickChatRecoveryLinks alternative={alternative} />
        </Banner>
      </Stack>
    );
  }

  /*
   * Keyed on the Bot, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run.
   */
  return (
    <BotChat
      agentId={agentId}
      draftKey={draftKey}
      key={agentId}
      name={bot.name}
      purpose={bot.roleDescription?.trim()}
      runsOnOpenBotModel={bot.runsOnOpenBotModel === true}
      visibility={bot.visibility}
    />
  );
}

function BotChat({
  agentId,
  draftKey,
  name,
  purpose,
  runsOnOpenBotModel,
  visibility,
}: {
  agentId: string;
  draftKey?: string;
  name: string;
  purpose?: string;
  runsOnOpenBotModel: boolean;
  visibility: "public" | "private";
}) {
  const { t } = useTranslation();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const models = useQuery({
    ...modelCatalogueQueryOptions(),
    enabled: runsOnOpenBotModel,
  });
  // Tool calls here act on this Bot's own computer.
  useActiveBot(agentId);
  /*
   * Minted by this deployment rather than by the chat. `history` reports whether Intelligence
   * still recognised the thread this browser remembered from a previous visit; when it did not,
   * `useBotThread` has already swapped in a fresh id on its own; this flag exists only so the
   * page can say so instead of letting the Bot answer as if nothing were missing. `startNew`
   * mints another fresh thread on demand for the New chat control below.
   */
  const {
    threadId,
    history,
    startNew,
    retryHistory,
    checkingHistory,
    starting,
    startFailed,
  } = useBotThread(agentId);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const newConversationButton = useRef<HTMLButtonElement>(null);
  const cancelNewConversation = useRef<HTMLButtonElement>(null);
  // What the Bot did on its computer in this conversation, for the Activity pane beside its screen.
  useBotActivity(agentId);
  // Before the first render, which is when the composer reads the draft.
  useState(() => keepEarlierDraft(draftKey));
  const { watch } = Route.useSearch();
  const navigate = Route.useNavigate();
  const showComputer = (open: boolean) =>
    navigate({
      search: (previous) => ({ ...previous, watch: open ? true : undefined }),
    });
  // A command in the chat clicked opens the Computer on its terminal.
  useOpenComputerOnRequest(agentId, () => showComputer(true));

  return (
    <DetailPanel
      title="Computer"
      open={watch === true}
      onClose={() => showComputer(false)}
      waiting={threadId ? <ConversationApprovals threadId={threadId} /> : null}
      detail={<ComputerViewPanel agentId={agentId} name={name} />}
    >
      {/*
       * The Astryx theme around the header and the chat together, so the transcript, the composer and
       * the cards resolve the same palette a Conversation does, in either appearance.
       */}
      <ConversationSurface>
        <Stack height="100%" minHeight={0}>
          <SidebarToggleBar />
          <Stack
            align="center"
            as="header"
            direction="horizontal"
            gap={3}
            justify="between"
            style={{
              paddingBlock: "var(--spacing-3)",
              paddingInline: "var(--spacing-4)",
            }}
            wrap="wrap"
          >
            <Stack gap={1} style={{ minWidth: 0 }}>
              <Heading
                id="quick-chat-title"
                level={1}
                tabIndex={-1}
                wordBreak="break-word"
              >
                {name}
              </Heading>
              {!personal && (
                <Text color="secondary" type="supporting">
                  {visibility === "public"
                    ? t("conversation.scope.public")
                    : t("conversation.scope.private")}
                </Text>
              )}
              {purpose &&
              purpose.toLowerCase() !== name.trim().toLowerCase() ? (
                <Collapsible
                  defaultIsOpen={false}
                  trigger={t("conversation.quick.about")}
                >
                  <Text
                    as="p"
                    color="secondary"
                    display="block"
                    style={{
                      maxBlockSize: "min(25dvh, 6lh)",
                      overflowY: "auto",
                      overflowWrap: "anywhere",
                    }}
                    tabIndex={0}
                    type="supporting"
                  >
                    {purpose}
                  </Text>
                </Collapsible>
              ) : null}
            </Stack>
            <Stack
              align="center"
              className="quick-chat-actions"
              direction="horizontal"
              gap={2}
              wrap="wrap"
            >
              <ComputerChatControls
                computerId={agentId}
                open={watch === true}
                onOpenChange={showComputer}
              />
              <AstryxButton
                icon={<IconPlus />}
                isLoading={starting}
                isDisabled={!threadId}
                label="New chat with this Bot"
                onClick={() => setShowNewConversation(true)}
                ref={newConversationButton}
                size="md"
                variant="secondary"
              />
            </Stack>
          </Stack>
          <Divider />
          <Dialog
            open={showNewConversation}
            onOpenChange={setShowNewConversation}
          >
            <DialogContent
              {...astryxScope}
              finalFocus={newConversationButton}
              initialFocus={cancelNewConversation}
              role="alertdialog"
              showCloseButton={false}
            >
              <DialogTitle>Start a new conversation?</DialogTitle>
              <DialogDescription>
                The new conversation starts with an empty history.
                {draftKey ? " Your saved draft stays with this Bot." : null}
              </DialogDescription>
              <DialogFooter className="flex-wrap">
                <AstryxButton
                  className="confirmation-action"
                  label="Cancel"
                  onClick={() => setShowNewConversation(false)}
                  ref={cancelNewConversation}
                  variant="secondary"
                />
                <AstryxButton
                  className="confirmation-action"
                  label="Start new conversation"
                  onClick={() => {
                    setShowNewConversation(false);
                    startNew();
                  }}
                  variant="primary"
                />
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {history === "unavailable" ? (
            <ConversationReadError
              title="Couldn't check your earlier messages."
              description="This conversation is still open. You can check whether earlier messages are available."
              retryLabel="Check history"
              retryBelow
              retry={retryHistory}
              retrying={checkingHistory}
            />
          ) : null}
          {history === "missing" && (
            <Banner
              status="warning"
              title="Earlier messages are no longer available."
              description="You can start a new conversation with this Bot."
              role="status"
            />
          )}
          {runsOnOpenBotModel &&
            ((models.isError && !models.data) ||
              models.data?.choicesUnavailable) && (
              <ConversationReadError
                title={t("conversation.models.loadFailed")}
                retry={() => void models.refetch()}
                retrying={models.isFetching}
              />
            )}
          {startFailed && (
            <ConversationReadError
              title="Couldn't start a new conversation."
              description={
                threadId
                  ? "Your current conversation is still open."
                  : "Try again to start chatting with this Bot."
              }
              retry={startNew}
              retryBelow
              retrying={starting}
            />
          )}
          {/*
           * Keyed on the thread as well as the agent: `startNew` changes only the thread, and a view
           * that stayed mounted would keep the previous conversation on screen under a composer that
           * posts to the new one.
           */}
          <Stack minHeight={0} style={{ flex: 1 }}>
            {threadId ? (
              <BotChatView
                agentId={agentId}
                draftKey={draftKey}
                key={`${agentId}:${threadId}`}
                threadId={threadId}
              />
            ) : !startFailed ? (
              <ConversationLoading label="Opening conversation…" />
            ) : null}
          </Stack>
        </Stack>
      </ConversationSurface>
    </DetailPanel>
  );
}
