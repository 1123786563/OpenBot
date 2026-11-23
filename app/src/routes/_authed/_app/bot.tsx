import { Banner } from "@astryxdesign/core/Banner";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Stack } from "@astryxdesign/core/Stack";
import {
  CopilotChat,
  CopilotChatInput,
  type CopilotChatInputProps,
} from "@copilotkit/react-core/v2";
import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { z } from "zod";
import { ConversationApprovals } from "@/components/approvals/inline-approval";
import {
  ConversationLoading,
  ConversationReadError,
} from "@/components/channels/conversation-status";
import { TelemetryAssistantMessage } from "@/components/channels/telemetry-assistant-message";
import { ComputerChatControls } from "@/components/computer/computer-controls";
import { ComputerViewPanel } from "@/components/computer/computer-panel";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { defaultAgentId } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentKeys,
  agentListQueryOptions,
} from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  composeDraftKey,
  readComposeDraft,
  writeComposeDraft,
} from "@/lib/channels/compose-draft";
import { tryClient } from "@/lib/client";
import { useOpenComputerOnRequest } from "@/lib/computers/panel-view";
import { useActiveBot } from "@/lib/copilot/active-bot";
import { useBotActivity } from "@/lib/copilot/bot-activity";
import { useBotThread } from "@/lib/copilot/bot-thread";
import { useStoppedTurn } from "@/lib/copilot/stopped-turn";
import { searchTextEntry } from "@/lib/search-text";

const QuickDraftKey = createContext<string | undefined>(undefined);
const quickDraftText = z.string();

function QuickChatInput({ value, onChange, ...input }: CopilotChatInputProps) {
  const key = useContext(QuickDraftKey);
  const draft = useRef<{ key: string; restoring?: string } | undefined>(
    undefined,
  );
  useLayoutEffect(() => {
    if (!key || !onChange) return;
    if (draft.current?.key !== key) {
      const saved = value ? undefined : readComposeDraft(key, quickDraftText);
      draft.current = { key, restoring: saved };
      if (saved) {
        onChange(saved);
        return;
      }
    }
    if (draft.current.restoring) {
      if (value !== draft.current.restoring) return;
      draft.current.restoring = undefined;
    }
    writeComposeDraft(key, value || undefined);
  }, [key, onChange, value]);

  return (
    <CopilotChatInput
      {...input}
      addMenuButton={{ className: "quick-chat-touch-target" }}
      cancelTranscribeButton={{ className: "quick-chat-touch-target" }}
      finishTranscribeButton={{ className: "quick-chat-touch-target" }}
      onChange={onChange}
      sendButton={{ className: "quick-chat-touch-target" }}
      startTranscribeButton={{ className: "quick-chat-touch-target" }}
      textArea={{
        "aria-label": "Message",
        className: "quick-chat-message",
        placeholder: "Describe what you want to get done…",
      }}
      value={value}
    />
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
type BotDetailLookup =
  | { bot: AgentProfile; status: "found" }
  | { status: "missing" };

function isAgentEnvelope(body: unknown): body is { agent: AgentProfile } {
  if (body === null || typeof body !== "object") return false;
  const agent = (body as { agent?: unknown }).agent;
  return (
    agent !== null &&
    typeof agent === "object" &&
    typeof (agent as { id?: unknown }).id === "string" &&
    typeof (agent as { name?: unknown }).name === "string"
  );
}

async function loadExplicitBot(agentId: string): Promise<BotDetailLookup> {
  const response = await tryClient(
    `/api/agents/${encodeURIComponent(agentId)}`,
  );
  if (response.status === 404) return { status: "missing" };
  if (!response.ok) throw new Error("Couldn't load this Bot.");

  const body: unknown = await response.json().catch(() => null);
  if (!isAgentEnvelope(body)) throw new Error("Couldn't load this Bot.");
  return { bot: body.agent, status: "found" };
}

function RouteComponent() {
  const search = Route.useSearch();
  const agent = search.agent === "" ? undefined : search.agent;
  const {
    data: agents,
    isError,
    isPending,
    isFetching,
    refetch,
  } = useQuery(agentListQueryOptions());
  const agentId = agent ?? defaultAgentId(agents);
  const listedBot = agents?.find((candidate) => candidate.id === agentId);
  const detailAgentId = agent ?? "";
  const shouldLoadExplicitBot =
    Boolean(agent) && agents !== undefined && listedBot === undefined;
  const {
    data: detail,
    isError: isDetailError,
    isPending: isDetailPending,
    isFetching: isDetailFetching,
    refetch: refetchDetail,
  } = useQuery({
    enabled: shouldLoadExplicitBot,
    queryKey: agentKeys.botRouteDetail(detailAgentId),
    queryFn: () => loadExplicitBot(detailAgentId),
    retry: false,
  });
  const bot =
    listedBot ?? (detail?.status === "found" ? detail.bot : undefined);
  const known = bot !== undefined;

  if (isPending || (shouldLoadExplicitBot && isDetailPending)) {
    return <ConversationLoading label="Finding your Bot…" />;
  }
  if (isError && agents === undefined) {
    return (
      <Stack padding={5}>
        <ConversationReadError
          title="Couldn't load your Bots."
          description="Try loading the Bot list again."
          retry={() => void refetch()}
          retrying={isFetching}
        />
      </Stack>
    );
  }
  if (shouldLoadExplicitBot && isDetailError) {
    return (
      <Stack padding={5}>
        <ConversationReadError
          title="Couldn't load this Bot."
          description="Try opening the Bot again."
          retry={() => void refetchDetail()}
          retrying={isDetailFetching}
        />
      </Stack>
    );
  }
  if (!agentId || !known) {
    return (
      <Stack padding={5}>
        <Banner
          status="info"
          title={
            agent
              ? `There's no Bot called "${agent}".`
              : "There are no Bots yet."
          }
          endContent={
            <AstryxButton label="Browse Bots" href="/bots" size="sm" />
          }
        />
      </Stack>
    );
  }

  /*
   * Keyed on the Bot, so the hooks below never see it change under them. They cannot be called
   * conditionally, and the guards above return before any of them run.
   */
  return <BotChat agentId={agentId} key={agentId} name={bot.name} />;
}

function BotChat({ agentId, name }: { agentId: string; name: string }) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const draftKey = composeDraftKey(
    user?.id,
    `quick:${encodeURIComponent(agentId)}`,
    "message",
  );
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
  /*
   * A turn that ends without an answer has to be said out loud here, because the packaged chat says
   * nothing. It reports a failed run to an `onError` prop and otherwise carries on as though the
   * turn simply finished: the composer unlocks, the spinner goes, and the transcript keeps the
   * person's own message with nothing under it. The banner that would have explained it belongs to
   * a provider this app does not mount.
   */
  const stopped = useStoppedTurn(agentId);
  // What the Bot did on its computer in this conversation, for the Activity pane beside its screen.
  useBotActivity(agentId);
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
          <Heading level={1} wordBreak="break-word">
            {name}
          </Heading>
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
              label="Start fresh"
              onClick={startNew}
              size="md"
              variant="secondary"
            />
          </Stack>
        </Stack>
        <Divider />
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
        {startFailed && (
          <ConversationReadError
            title="Couldn't start a new conversation."
            description="Your current conversation is still open."
            retry={startNew}
            retryBelow
            retrying={starting}
          />
        )}
        {/*
         * Under the header rather than at the end of the transcript, which is where the missing answer
         * was going to be and where the channel draws its own version of this. The packaged chat owns
         * that list and virtualises it, so reaching into it means replacing the whole message view and
         * taking on its scrolling. The cost of putting the sentence here instead is that it is not
         * beside the gap it explains; what it buys is that it is always on screen, whatever the
         * transcript has been scrolled to, and that it survives the next release of the chat.
         */}
        {stopped ? (
          <Banner
            role="alert"
            status="error"
            title="The Bot stopped before replying."
            description={stopped}
          />
        ) : null}
        <Stack minHeight={0} style={{ flex: 1 }}>
          {/*
           * Keyed on the thread as well as the agent. Switching agents was already handled by
           * `agentId`, but `startNew` changes only the thread while the agent stays put, and the
           * packaged chat's own `startNewThread`/`setActiveThreadId` are proven no-ops once
           * `threadId` is a controlled prop (node_modules/@copilotkit/react-core/dist/copilotkit-
           * C4RqjAba.mjs:226-254): asking it to start over does nothing while it still holds the
           * old id. A key that omits the thread would leave the previous conversation on screen
           * under a composer that silently posts to the new one.
           */}
          {threadId ? (
            <QuickDraftKey.Provider value={draftKey}>
              <CopilotChat
                agentId={agentId}
                input={QuickChatInput}
                messageView={{ assistantMessage: TelemetryAssistantMessage }}
                key={`${agentId}:${threadId}`}
                threadId={threadId}
              />
            </QuickDraftKey.Provider>
          ) : (
            <ConversationLoading label="Opening conversation…" />
          )}
        </Stack>
      </Stack>
    </DetailPanel>
  );
}
