import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { text } from "prompt-area/helpers";
import { useEffect, useRef, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  ConversationLoading,
  ConversationReadError,
} from "@/components/channels/conversation-status";
import { FirstMessageDraftCopy } from "@/components/channels/first-message-draft-copy";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import { buttonVariants } from "@/components/ui/button";
import { agentListQueryOptions, agentQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import type { BillingQuote } from "@/lib/billing/queries";
import {
  composeDraftKey,
  writeComposeDraft,
} from "@/lib/channels/compose-draft";
import {
  discardPendingStart,
  isTemporaryStart,
  readPendingStart,
} from "@/lib/channels/pending-start";
import {
  CoworkerRoutingQuoteRequired,
  CoworkerRoutingRefusedError,
} from "@/lib/channels/route";
import { resumeConversationStart } from "@/lib/channels/start";
import { ClientError } from "@/lib/client";
import { newId } from "@/lib/new-id";

export const Route = createFileRoute("/_authed/_app/start/$startId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { startId } = Route.useParams();
  const {
    data: user,
    isPending,
    isFetching,
    refetch,
  } = useQuery(currentUserQueryOptions());
  if (isPending) return <ConversationLoading label="Opening saved message…" />;
  return user ? (
    <StartHandoff
      owner={user.id}
      startId={startId}
      key={`${user.id}:${startId}`}
    />
  ) : (
    <Stack padding={5}>
      <ConversationReadError
        title="Couldn't open your saved message."
        description="Your account needs to load before the conversation can continue."
        retry={() => void refetch()}
        retryBelow
        retrying={isFetching}
      />
    </Stack>
  );
}

function StartHandoff({ owner, startId }: { owner: string; startId: string }) {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const {
    requestConfirmation: requestDiscard,
    confirmation: discardConfirmation,
  } = useActionConfirmation();
  const [start, setStart] = useState(() => readPendingStart(owner, startId));
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<
    | { kind: "retry" }
    | { kind: "choose-bot"; message: string; matches?: readonly string[] }
    | null
  >(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const [quote, setQuote] = useState<BillingQuote>();
  const [confirmation, setConfirmation] =
    useState<Pick<BillingQuote, "route" | "priceVersion">>();

  const hasStart = start?.state === "pending";
  const temporary = isTemporaryStart(owner, startId);
  useEffect(() => {
    // This state is intentionally a retry trigger. The effect must restart when the user taps Retry.
    void attempt;
    if (!hasStart) return;
    let current = true;
    void resumeConversationStart(
      queryClient,
      owner,
      startId,
      (next) => {
        if (current) setStart(next);
      },
      confirmation,
    ).then(
      (next) => {
        if (current) setStart(next);
      },
      (cause: unknown) => {
        if (!current) return;
        const saved = readPendingStart(owner, startId);
        setStart(saved);
        if (cause instanceof CoworkerRoutingQuoteRequired) {
          setFailure(null);
          setQuote(cause.quote);
          return;
        }
        setQuote(undefined);
        if (saved?.state === "pending" && saved.progress.phase === "creating") {
          if (cause instanceof CoworkerRoutingRefusedError) {
            setFailure({
              kind: "choose-bot",
              message: "Choose a Bot for this message.",
              matches: cause.names,
            });
            return;
          }
          if (
            saved.draft.recipient.kind === "route" &&
            cause instanceof ClientError &&
            cause.status === 409
          ) {
            setFailure({ kind: "choose-bot", message: cause.message });
            return;
          }
          if (
            cause instanceof ClientError &&
            (cause.status === 403 || cause.status === 404)
          ) {
            setFailure({
              kind: "choose-bot",
              message: "This conversation can’t start with the selected Bots.",
            });
            return;
          }
        }
        setFailure({ kind: "retry" });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, confirmation, hasStart, owner, queryClient, startId]);

  const draft = hasStart ? start.draft : undefined;
  const agentId =
    draft?.recipient.kind === "direct" ? draft.recipient.agentId : undefined;
  const roster = useQuery(agentListQueryOptions());
  const listed = roster.data?.find((agent) => agent.id === agentId);
  const fetched = useQuery({
    ...agentQueryOptions(agentId ?? ""),
    enabled: Boolean(agentId) && roster.data !== undefined && !listed,
  });
  const bot = listed ?? fetched.data;

  if (start?.state === "finished") {
    return start.group ? (
      <Navigate
        params={{ channelId: start.channelId }}
        replace
        to="/group/$channelId"
      />
    ) : (
      <Navigate
        params={{ channelId: start.channelId }}
        replace
        to="/channel/$channelId"
      />
    );
  }
  if (
    start?.state === "pending" &&
    start.draft.recipient.kind === "direct" &&
    start.progress.phase !== "creating"
  ) {
    return (
      <Navigate
        params={{ channelId: start.progress.channelId }}
        replace
        to="/channel/$channelId"
      />
    );
  }

  return (
    <Stack className="flex-1" minHeight={0}>
      <Stack
        as="header"
        className="min-h-12 shrink-0 border-b border-border px-3 py-2"
        direction="horizontal"
        align="center"
        justify="between"
        gap={3}
        data-slot="conversation-header"
      >
        <Stack
          direction="horizontal"
          align="center"
          gap={2}
          className="min-w-0"
        >
          <SidebarToggle />
          {agentId ? (
            <ChannelAvatar participantIds={[agentId]} size={22} />
          ) : null}
          <h1 className="min-w-0 text-sm truncate" ref={heading} tabIndex={-1}>
            {bot?.name ?? "New conversation"}
          </h1>
        </Stack>
        <Link
          className={buttonVariants({
            className: "min-h-11",
            variant: "ghost",
          })}
          to="/"
        >
          Back to Home
        </Link>
      </Stack>
      {start?.state === "pending" && draft ? (
        <>
          <Stack className="flex-1" minHeight={0}>
            <ChatTranscript messages={[seedMessage(draft.text, startId)]} />
          </Stack>
          <Stack
            className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4"
            gap={2}
          >
            {quote ? (
              <Banner
                status="info"
                title="Use Test Credits to pick a Bot?"
                description={`${quote.provider}/${quote.model} charges ${quote.price.inputPerMillion} input and ${quote.price.outputPerMillion} output microcredits per million tokens. Maximum ${quote.maxChargeMicrocredits} microcredits for routing. ${quote.usageDisclosure} Your conversation has a separate quote.`}
                endContent={
                  <Button
                    label="Confirm routing"
                    onClick={() => {
                      setConfirmation({
                        route: quote.route,
                        priceVersion: quote.priceVersion,
                      });
                      setQuote(undefined);
                      setAttempt((value) => value + 1);
                    }}
                  />
                }
              />
            ) : failure?.kind === "choose-bot" ? (
              <Banner
                collapsible={false}
                status="warning"
                role="alert"
                title={failure.message}
                description={
                  draft.text
                    ? "Your original stays saved here. A new conversation opens with a copy of its text."
                    : "Your original stays saved here."
                }
              >
                {failure.matches?.length ? (
                  <Text
                    as="p"
                    className="[overflow-wrap:anywhere]"
                    color="secondary"
                    size="sm"
                  >
                    Matching Bots: {failure.matches.join(", ")}
                  </Text>
                ) : null}
                {draft.attachments.length > 0 ? (
                  <Text as="p" color="secondary" size="sm">
                    You can add the saved files to the new conversation before
                    sending.
                  </Text>
                ) : null}
                <Stack direction="horizontal" gap={2} wrap="wrap">
                  {draft.text ? (
                    <FirstMessageDraftCopy
                      label="Copy message text"
                      text={draft.text}
                    />
                  ) : null}
                  <Button
                    className="conversation-recovery-action"
                    label="Choose Bots in a new conversation"
                    onClick={() => {
                      const newConversation = newId();
                      writeComposeDraft(
                        composeDraftKey(owner, newConversation, "message"),
                        draft.text ? [text(draft.text)] : undefined,
                      );
                      void navigate({
                        to: "/channel/new",
                        state: {
                          newConversation,
                          copiedFromHome: true,
                          copiedFromStart: true,
                          copiedStartId: startId,
                        },
                      });
                    }}
                    variant="secondary"
                  />
                </Stack>
              </Banner>
            ) : failure ? (
              <ConversationReadError
                title="Couldn't continue the conversation."
                description={
                  start.progress.phase === "submitted"
                    ? "Try again to check whether your first message arrived before sending it again."
                    : "Try again to continue with your saved message."
                }
                focusAfterRetry={() => heading.current}
                retry={() => {
                  setFailure(null);
                  setAttempt((value) => value + 1);
                }}
                retryBelow
                retryLabel="Retry saved message"
                retrying={false}
              />
            ) : (
              <ConversationLoading
                label={
                  draft.recipient.kind === "route"
                    ? "Finding a Bot for your message…"
                    : start.progress.phase === "creating"
                      ? "Creating conversation…"
                      : "Checking the first message…"
                }
              />
            )}
            {failure ? (
              <Button
                className="conversation-recovery-action"
                label="Discard saved message"
                onClick={(event) => {
                  requestDiscard({
                    title: "Discard the message saved in this browser?",
                    description:
                      "This removes the copy saved in this browser and takes it off Home's resume list. Any message that reached the conversation stays there.",
                    confirmLabel: "Discard saved message",
                    pendingLabel: "Discarding message…",
                    failureMessage:
                      "Couldn't remove the saved message. Try again.",
                    successMessage: "Saved message discarded.",
                    trigger: event.currentTarget,
                    run: async () => {
                      discardPendingStart(owner, startId);
                      await navigate({ to: "/" });
                    },
                  });
                }}
                size="sm"
              />
            ) : null}
            {temporary ? (
              <Stack align="start" gap={1}>
                <Text as="p" color="secondary" size="sm" role="status">
                  This message is saved only in this tab. Copy it before closing
                  or refreshing this tab.
                </Text>
                {draft.text && failure?.kind !== "choose-bot" ? (
                  <FirstMessageDraftCopy
                    label="Copy message text"
                    text={draft.text}
                  />
                ) : null}
              </Stack>
            ) : failure?.kind === "retry" ? (
              <Text as="p" color="secondary" size="sm">
                Your message is saved in this browser. You can also resume it
                from Home.
              </Text>
            ) : null}
            {draft.attachments.length > 0 ? (
              <Text
                as="p"
                className="[overflow-wrap:anywhere]"
                color="secondary"
                size="sm"
              >
                Saved attachments:{" "}
                {draft.attachments.map(({ name }) => name).join(", ")}
              </Text>
            ) : null}
          </Stack>
        </>
      ) : (
        <Banner
          collapsible={false}
          status="warning"
          title="This conversation start is unavailable."
          description="To resume this message, open the link in the browser where you sent it."
        >
          <Link
            className={buttonVariants({
              className: "conversation-recovery-action",
              variant: "outline",
            })}
            to="/channel/new"
          >
            New conversation
          </Link>
        </Banner>
      )}
      {discardConfirmation}
    </Stack>
  );
}
