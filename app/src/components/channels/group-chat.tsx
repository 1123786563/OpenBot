import { Button as RecoveryButton } from "@astryxdesign/core/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type MouseEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { z } from "zod";
import { ConversationApprovals } from "@/components/approvals/inline-approval";
import {
  QuestionNotice,
  type WaitingQuestion,
} from "@/components/approvals/question-notice";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { useTranslation } from "@/i18n";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
  carryingOnAfterApproval,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  composeDraftKey,
  readComposeDraft,
  writeComposeDraft,
} from "@/lib/channels/compose-draft";
import { canKeepCachedRead } from "@/lib/client";
import { controlThreadRun } from "@/lib/copilot/thread-messages";
import {
  awaitingFirstReply,
  type GroupBackgroundRun,
  type GroupMessage,
  groupKeys,
  groupQueryOptions,
  sendGroupMessageMutationOptions,
  stopGroupTurnMutationOptions,
} from "@/lib/groups";
import {
  markdownComponents,
  markdownPlugins,
  replyRemarkPlugins,
} from "@/lib/markdown";
import { newId } from "@/lib/new-id";
import { ChannelAvatar } from "./avatar";
import { Composer, toAgentOptions } from "./composer";
import {
  ConversationLoading,
  ConversationReadError,
  ConversationUnavailable,
} from "./conversation-status";
import { RUN_STAGE, RUN_WAS_STOPPED, runOutcomeWords } from "./run-stage";
import { TeamBotConsentCard } from "./team-bot-consent";

const groupSubmission = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    id: z.string(),
    text: z.string(),
    agentId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("answer"),
    id: z.string(),
    text: z.string(),
    agentId: z.string().nullable(),
  }),
]);

let activityReturn: { entry: string; messageId: string } | undefined;

/**
 * One conversation with several Bots, read from the server's shared transcript.
 *
 * Not the CopilotKit chat. Each Bot answers in a thread of its own on the server, so there is no one
 * agent for a browser run to bind to; the person posts a message, the server runs every addressed
 * Bot through the ordinary headless AG-UI path, and this draws what each of them said, attributed.
 * `@Name` in the composer addresses one Bot; otherwise every Bot answers, one after another.
 *
 * A Bot here can ask the person something (`ask_person`), as it can in a conversation of its own.
 * The question waits above the composer, and what the person sends while it does is their answer,
 * unless they address another Bot. The server puts the answer in the transcript and runs the Bot
 * that asked on it (`approvals/questions.ts`).
 */
export function GroupChat({
  channelId,
  historyEntry,
  runId,
}: {
  channelId: string;
  historyEntry?: string;
  runId?: string;
}) {
  const { t } = useTranslation();
  const [returningFromActivity] = useState(() =>
    activityReturn?.entry === historyEntry ? activityReturn : undefined,
  );
  const queryClient = useQueryClient();
  const group = useQuery(groupQueryOptions(channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  const draftEntry = `group:${encodeURIComponent(channelId)}`;
  const draftKey = composeDraftKey(me?.id, draftEntry, "message");
  const submissionKey = composeDraftKey(me?.id, draftEntry, "submission");
  const send = useMutation(
    sendGroupMessageMutationOptions(queryClient, channelId),
  );
  const pendingSubmission = useRef<z.infer<typeof groupSubmission> | undefined>(
    undefined,
  );
  const bots = group.data?.bots ?? [];
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const people = new Map(
    group.data?.people.map((person) => [
      person.userId,
      person.name ?? person.email,
    ]),
  );
  const messages = group.data?.messages ?? [];
  const background = group.data?.backgroundRuns ?? [];
  /*
   * A Bot waiting on an approval asks in this conversation, as it does in a conversation of its own:
   * the same card, from the same inbox. The wait shows on the Bot's line, or on the run the server
   * holds for it, and one thread asks once.
   */
  const askingThreads = [
    ...new Set([
      ...messages.flatMap((message) =>
        message.status === "waiting" && message.threadId
          ? [message.threadId]
          : [],
      ),
      ...background.flatMap((run) =>
        run.waitingForApproval && run.threadId ? [run.threadId] : [],
      ),
    ]),
  ];
  const working =
    background.some(({ status }) => status === "running") ||
    messages.some(
      (message) => message.status === "running" || message.status === "queued",
    );

  const inbox = useQuery(approvalInboxOptions());
  /*
   * THE REPLY AFTER A DECISION. A Bot's line that waits on an approval stays "waiting" until the
   * server has carried the turn on and written the reply into it (`continueWaiting` in group.ts), so
   * nothing marks it as working, and the transcript is read slowly meanwhile (`groupPollInterval`).
   * The approvals are read every 10 s and at once after a decision. When they say the server has
   * started, or stopped, carrying a waiting line on, the transcript is read again.
   */
  const carriedOn = new Set(
    messages.flatMap((message) =>
      message.status === "waiting" &&
      message.threadId &&
      carryingOnAfterApproval(inbox.data, message.threadId)
        ? [message.id]
        : [],
    ),
  );
  const carryingOn =
    carriedOn.size > 0 ||
    background.some(
      (run) =>
        run.waitingForApproval &&
        carryingOnAfterApproval(inbox.data, run.threadId),
    );
  const seenCarriedOn = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const before = seenCarriedOn.current;
    seenCarriedOn.current = carryingOn;
    if (before !== undefined && before !== carryingOn)
      void queryClient.invalidateQueries({
        queryKey: groupKeys.detail(channelId),
      });
  }, [carryingOn, channelId, queryClient]);
  const question = groupQuestion(inbox.data, channelId);
  // The Bot whose conversation it is: for a hand-off, the one that handed the work on.
  const askerId = question?.conversationBotId ?? question?.botId;
  const asker = useQuery(agentListQueryOptions()).data?.find(
    (bot) => bot.id === askerId,
  );
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
  const stop = useMutation(
    stopGroupTurnMutationOptions(queryClient, channelId),
  );
  const stopInFlight = useRef(false);
  async function stopTurn(id: string) {
    if (stopInFlight.current) return;
    stopInFlight.current = true;
    try {
      await stop.mutateAsync(id);
    } catch {
      // The message keeps its Stop control until the server confirms.
    } finally {
      stopInFlight.current = false;
    }
  }
  const reconcile = useMutation({
    mutationFn: (run: GroupBackgroundRun) =>
      controlThreadRun({
        action: "reconcile",
        threadId: run.threadId,
        agentId: run.agentId,
        runId: run.id,
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });

  const answerTo = async (text: string, questionId: string) => {
    await answer.mutateAsync({ id: questionId, response: text });
    // The answer is in the transcript now, and the Bot's turn on it is queued.
    await queryClient.invalidateQueries({
      queryKey: groupKeys.detail(channelId),
    });
  };
  /*
   * The inbox is read every 10 s, and a Bot that asks ends its turn on the question. Read again the
   * moment the Bots stop, so the question is above the composer when the reply that asks it is.
   */
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working)
      void queryClient.invalidateQueries({
        queryKey: approvalInboxOptions().queryKey,
      });
    wasWorking.current = working;
  }, [working, queryClient]);

  /*
   * LAND AT THE BOTTOM BEFORE THE FIRST PAINT, THEN FOLLOW ONLY A READER WHO IS STILL THERE.
   *
   * This was `scrollIntoView` in a `useEffect`, which runs after the browser has painted: every
   * group chat showed its top for a frame and then jumped. A layout effect moves it before paint.
   * And it followed every new line unconditionally, pulling somebody reading an earlier answer back
   * down each time a Bot spoke; `atBottom` is where the reader was at their last scroll.
   */
  const viewportRef = useRef<HTMLElement | null>(null);
  const replyRefresh = useRef<{
    button: HTMLElement;
    promptId: string;
    before: GroupMessage[];
    checkedAt: number;
  } | null>(null);
  const restoredActivityFocus = useRef<HTMLElement | null>(null);
  const atBottom = useRef(true);
  // Once per mount, which is once per channel: the route keys `GroupChat` on its channel id.
  const landed = useRef(false);
  const newest = messages.at(-1);
  const awaitingReply =
    newest?.agentId === null &&
    newest.stopReason !== "stopped" &&
    bots.length > 0 &&
    !question;
  // Reading dataUpdatedAt keeps this status current even if a poll returns the same transcript.
  const checkingForReply =
    awaitingReply && group.dataUpdatedAt > 0 && awaitingFirstReply(newest);
  const newestIsMine = newest !== undefined && newest.ownerUserId === me?.id;
  const lastKey = `${messages.length}:${newest?.status ?? ""}`;
  async function refreshReplies(button: HTMLElement) {
    replyRefresh.current =
      newest && document.activeElement === button
        ? {
            button,
            promptId: newest.id,
            before: messages,
            checkedAt: group.dataUpdatedAt,
          }
        : null;
    await group.refetch();
  }
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null || lastKey === "0:") return;
    if (
      shouldFollowGroup({
        landed: landed.current,
        atBottom: atBottom.current,
        newestIsMine,
      })
    ) {
      element.scrollTop = element.scrollHeight;
      landed.current = true;
      atBottom.current = true;
    }
  }, [lastKey, newestIsMine]);

  const focus = useRef<HTMLDivElement>(null);
  const linkedRun =
    background.find(({ id }) => id === runId) ??
    messages.find(({ id }) => id === runId);
  useLayoutEffect(() => {
    if (linkedRun) focus.current?.scrollIntoView({ block: "nearest" });
  }, [linkedRun]);

  useLayoutEffect(() => {
    const intent = replyRefresh.current;
    if (
      !intent ||
      (messages === intent.before && group.dataUpdatedAt === intent.checkedAt)
    )
      return;
    replyRefresh.current = null;
    const viewport = viewportRef.current;
    if (
      !viewport ||
      intent.button.isConnected ||
      document.activeElement !== document.body
    )
      return;
    const promptIndex = messages.findIndex(
      (message) => message.id === intent.promptId,
    );
    const nextReply =
      promptIndex < 0
        ? undefined
        : messages
            .slice(promptIndex + 1)
            .find((message) => message.agentId !== null);
    const target =
      nextReply &&
      viewport.querySelector<HTMLElement>(
        `[data-group-message="${CSS.escape(nextReply.id)}"]`,
      );
    if (target) target.focus();
    else viewport.focus({ preventScroll: true });
  }, [group.dataUpdatedAt, messages]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!returningFromActivity || !group.data || !viewport) return;
    if (activityReturn === returningFromActivity) activityReturn = undefined;
    if (
      restoredActivityFocus.current?.isConnected ||
      document.activeElement !== document.body
    )
      return;
    const link = viewport.querySelector<HTMLElement>(
      `[data-reply-activity="${CSS.escape(returningFromActivity.messageId)}"]`,
    );
    const target = link ?? viewport;
    target.focus();
    restoredActivityFocus.current = target;
    atBottom.current = isNearBottom(viewport);
  }, [group.data, returningFromActivity]);

  if (group.isPending && group.errorUpdateCount === 0)
    return <ConversationLoading label="Opening group conversation…" />;
  if (!group.data || !canKeepCachedRead(group.error))
    return (
      <ConversationUnavailable
        denied="You can't access this group conversation."
        description="The messages and participant list are unavailable."
        error={group.error}
        retry={() => void group.refetch()}
        retrying={group.isFetching}
        title="Couldn't open this group conversation."
      />
    );

  const empty = messages.length === 0 && background.length === 0;
  const replyGuide =
    bots.length === 0
      ? t("conversation.group.noBots")
      : bots.length === 1
        ? t("conversation.group.oneBot", { name: bots[0]?.name })
        : t("conversation.group.manyBots");

  return (
    <Stack minHeight={0} style={{ flex: 1 }}>
      {group.isError && !awaitingReply && (
        <ConversationReadError
          title="Couldn't update group messages."
          description="You can still read the messages already loaded."
          retry={() => void group.refetch()}
          retryBelow
          retrying={group.isFetching}
        />
      )}
      <section
        aria-label="Group messages"
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          atBottom.current = isNearBottom(event.currentTarget);
        }}
        ref={viewportRef}
        style={{ paddingInline: "var(--spacing-4, 1rem)" }}
        tabIndex={-1}
      >
        <div
          className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-6"
          data-transcript-column
        >
          {empty && (
            <Text as="p" role="status" type="supporting">
              {replyGuide}
            </Text>
          )}
          {messages.map((message) => (
            <GroupLine
              key={message.id}
              rowRef={message.id === runId ? focus : undefined}
              message={message}
              name={
                message.agentId
                  ? (names.get(message.agentId) ?? "A Bot no longer here")
                  : message.ownerUserId === me?.id
                    ? "You"
                    : (people.get(message.ownerUserId) ?? "A teammate")
              }
              answeredBy={
                message.answeredBy
                  ? (names.get(message.answeredBy) ?? "another Bot")
                  : undefined
              }
              stopAction={
                message.ownerUserId === me?.id &&
                group.data?.stoppableTurnIds?.includes(message.id) ? (
                  <Stack align="end" gap={1}>
                    <RecoveryButton
                      label="Stop this turn"
                      variant="ghost"
                      isDisabled={stop.isPending}
                      isLoading={
                        stop.isPending && stop.variables === message.id
                      }
                      clickAction={() => void stopTurn(message.id)}
                    />
                    {stop.isError && stop.variables === message.id ? (
                      <Text as="p" type="supporting" role="alert">
                        Couldn't stop this turn. Try again.
                      </Text>
                    ) : null}
                  </Stack>
                ) : undefined
              }
              mine={message.ownerUserId === me?.id}
              available={message.agentId !== null && names.has(message.agentId)}
              carryingOn={carriedOn.has(message.id)}
              rememberActivityLink={(event) => {
                if (
                  historyEntry &&
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  activityReturn = {
                    entry: historyEntry,
                    messageId: message.id,
                  };
                }
              }}
            />
          ))}
          {background.map((run) => (
            <MessageRow
              align="start"
              key={run.id}
              ref={run.id === runId ? focus : undefined}
              className="items-center"
            >
              <ChannelAvatar
                participantIds={[run.agentId]}
                size={24}
                typing={run.status === "running" && !run.waitingForApproval}
              />
              <MessageContent>
                <strong>{names.get(run.agentId)}</strong>
                {run.partialReply && (
                  <p className="whitespace-pre-wrap">{run.partialReply}</p>
                )}
                <Text as="p" role="status" type="supporting">
                  {run.reason ??
                    (run.externalOutcome === "executed" && !run.partialReply
                      ? "The outcome was verified."
                      : runOutcomeWords(run)) ??
                    (run.status === "failed"
                      ? RUN_STAGE.ended
                      : run.status === "running"
                        ? RUN_STAGE.running
                        : RUN_STAGE.completed)}
                </Text>
              </MessageContent>
              {run.externalOutcome === "unknown" ? (
                <Stack align="start" gap={1}>
                  <RecoveryButton
                    className="conversation-recovery-action"
                    label="Check outcome"
                    variant="ghost"
                    size="lg"
                    isDisabled={reconcile.isPending}
                    isLoading={
                      reconcile.isPending && reconcile.variables?.id === run.id
                    }
                    clickAction={() => reconcile.mutate(run)}
                  />
                  {reconcile.isError && reconcile.variables?.id === run.id ? (
                    <Text as="p" type="supporting" role="alert">
                      Couldn't check the outcome. Try again.
                    </Text>
                  ) : null}
                </Stack>
              ) : null}
            </MessageRow>
          ))}
          {awaitingReply && (
            <Stack align="start" gap={1}>
              <Text
                as="p"
                type="supporting"
                role={group.isError ? "alert" : "status"}
              >
                {group.isError
                  ? "Couldn't check for replies. Try again when you're ready."
                  : checkingForReply
                    ? "Message sent. No Bot reply yet."
                    : "No Bot reply received. Automatic refresh has stopped."}
              </Text>
              {(!checkingForReply || group.isError) && (
                <RecoveryButton
                  className="conversation-recovery-action"
                  label="Refresh messages"
                  variant="ghost"
                  size="lg"
                  isLoading={group.isFetching}
                  clickAction={(event) => refreshReplies(event.currentTarget)}
                />
              )}
            </Stack>
          )}
        </div>
      </section>
      {/* The same column and the same compact composer as a conversation with one Bot. */}
      <div className="mx-auto w-full max-w-2xl shrink-0 pb-4">
        {send.error && (
          <ConversationReadError
            title={t("conversation.group.sendFailed")}
            description={t("conversation.group.sendRecovery")}
            retrying={false}
          />
        )}
        {answer.error && (
          <ConversationReadError
            title={t("conversation.group.answerFailed")}
            description={t("conversation.group.answerRecovery")}
            retrying={false}
          />
        )}
        {askingThreads.map((threadId) => (
          <ConversationApprovals key={threadId} threadId={threadId} />
        ))}
        {/* The same drawer a conversation with one Bot draws its question in. */}
        {question ? (
          <div
            className="mx-5 -mb-4 rounded-t-2xl border border-border border-b-0 bg-muted pb-4"
            data-slot="composer-drawer"
          >
            <QuestionNotice
              avatarSeed={asker?.avatarSeed || (askerId ?? question.id)}
              botName={
                (askerId && names.get(askerId)) || asker?.name || "A Bot"
              }
              onAnswered={(text) => answerTo(text, question.id)}
              question={question}
            />
          </div>
        ) : null}
        {!question && !empty ? (
          <Stack
            style={{
              paddingInline: "var(--spacing-4)",
              paddingBlockEnd: "var(--spacing-2)",
            }}
          >
            <Text as="p" type="supporting">
              {replyGuide}
            </Text>
          </Stack>
        ) : null}
        <Composer
          agents={toAgentOptions(bots)}
          className="relative mt-auto w-full"
          commands={[]}
          compact
          draftStorageKey={draftKey}
          disabled={bots.length === 0}
          key={draftKey}
          pending={send.isPending || answer.isPending || working}
          autoFocus={!returningFromActivity}
          onSubmit={async (draft) => {
            if (!draft.text) return;
            const previous = submissionKey
              ? readComposeDraft(submissionKey, groupSubmission)
              : pendingSubmission.current;
            const matching =
              previous?.text === draft.text &&
              previous.agentId === draft.agentId;
            const submission: z.infer<typeof groupSubmission> = matching
              ? previous
              : question && (!draft.agentId || draft.agentId === askerId)
                ? {
                    kind: "answer",
                    id: question.id,
                    text: draft.text,
                    agentId: draft.agentId,
                  }
                : {
                    kind: "message",
                    id: newId(),
                    text: draft.text,
                    agentId: draft.agentId,
                  };
            pendingSubmission.current = submission;
            writeComposeDraft(submissionKey, submission);
            if (submission.kind === "answer") {
              await answerTo(submission.text, submission.id);
            } else {
              const { id, text, agentId } = submission;
              await send.mutateAsync({ id, text, agentId });
            }
            writeComposeDraft(draftKey);
            writeComposeDraft(submissionKey);
            pendingSubmission.current = undefined;
          }}
        />
      </div>
    </Stack>
  );
}

/**
 * The newest open question a Bot asked in this group, from an inbox read. Each Bot here asks from a
 * thread of its own, so it is found by the conversation, not by a thread.
 */
export function groupQuestion(
  inbox: ApprovalInboxData | null | undefined,
  channelId: string,
): WaitingQuestion | undefined {
  return inbox?.questions.find((question) => question.channelId === channelId);
}

/** One attributed line: a person's bubble, and a Bot's named reply on the left. */
function GroupLine({
  message,
  name,
  answeredBy,
  mine,
  rowRef,
  available,
  carryingOn,
  rememberActivityLink,
  stopAction,
}: {
  message: GroupMessage;
  name: string;
  answeredBy?: string;
  mine: boolean;
  rowRef?: Ref<HTMLDivElement>;
  available: boolean;
  /** The line waits on an approval the server is carrying on from: the Bot's turn again. */
  carryingOn: boolean;
  stopAction?: ReactNode;
  rememberActivityLink: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  if (message.agentId === null)
    return (
      <MessageRow align={mine ? "end" : "start"} ref={rowRef}>
        <MessageContent>
          {mine ? null : (
            <MessageHeader className="text-xs font-medium text-muted-foreground">
              {name}
            </MessageHeader>
          )}
          <Bubble align={mine ? "end" : "start"} variant="muted">
            <BubbleContent>
              <span className="whitespace-pre-wrap">{message.text}</span>
            </BubbleContent>
          </Bubble>
          {stopAction}
          {message.stopReason === "stopped" ? (
            <Text as="p" role="status" type="supporting">
              {RUN_WAS_STOPPED}
            </Text>
          ) : null}
        </MessageContent>
      </MessageRow>
    );
  return (
    <MessageRow
      align="start"
      data-group-message={message.id}
      data-speaker={message.agentId}
      ref={rowRef}
      tabIndex={-1}
    >
      <div className="shrink-0 pt-0.5">
        <ChannelAvatar
          participantIds={[message.agentId]}
          size={24}
          typing={message.status === "running" || carryingOn}
        />
      </div>
      <MessageContent>
        <MessageHeader className="text-xs font-medium text-muted-foreground">
          {name}
          {answeredBy ? ` · answer from ${answeredBy}` : null}
        </MessageHeader>
        {(message.status === "running" ||
          message.status === "queued" ||
          carryingOn) &&
        !message.text ? (
          <p
            className="tool-line-running text-sm text-muted-foreground"
            role="status"
          >
            {message.status === "queued" ? RUN_STAGE.queued : RUN_STAGE.running}
          </p>
        ) : message.status === "waiting" && !carryingOn ? (
          <p className="text-sm text-muted-foreground">
            {message.reason ?? "Waiting for your response."}{" "}
            <Link
              className="underline"
              params={{ agentId: message.agentId }}
              to="/bots/$agentId"
            >
              Open {name}
            </Link>
          </p>
        ) : message.consent ? (
          // Only the person whose account it asked for can answer; everyone else sees the ask.
          mine ? (
            <TeamBotConsentCard
              botId={message.consent.botId}
              message={message.text}
              serverId={message.consent.serverId}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Asked a teammate for permission to use their own{" "}
              {message.consent.serverId} account.
            </p>
          )
        ) : message.status === "paused" ? (
          <section aria-label="Paused Bot run" role="status">
            <Text as="p" type="supporting">
              {message.reason ?? message.text}
            </Text>
          </section>
        ) : message.stopReason === "stopped" ? (
          <Text as="p" role="status" type="supporting">
            {RUN_WAS_STOPPED}
          </Text>
        ) : message.status === "failed" ? (
          <Stack gap={1}>
            <Text
              as="p"
              role="status"
              style={{ color: "var(--color-text-error)" }}
              weight="semibold"
            >
              {name} couldn’t finish replying.
            </Text>
            {message.text && (
              <Text as="p" type="supporting" wordBreak="break-word">
                {message.text}
              </Text>
            )}
            <Text as="p" type="supporting">
              {!available
                ? "Choose an available Bot to continue."
                : mine
                  ? "If the request involved taking an action, check whether it went through before asking again."
                  : "If an action was requested, ask the teammate who sent the message to check the outcome before trying again."}
            </Text>
            {mine && available && message.agentId && (
              <Link
                className="recovery-link"
                data-reply-activity={message.id}
                onClick={rememberActivityLink}
                params={{ agentId: message.agentId }}
                to="/bots/$agentId/activity"
              >
                View {name} activity
              </Link>
            )}
          </Stack>
        ) : (
          <Bubble
            align="start"
            aria-busy={message.status === "running"}
            variant="ghost"
            className="w-full"
          >
            <BubbleContent className="w-full">
              <Streamdown
                components={markdownComponents}
                plugins={markdownPlugins}
                remarkPlugins={replyRemarkPlugins}
              >
                {message.text}
              </Streamdown>
            </BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </MessageRow>
  );
}

/**
 * Whether a scrolled element is close enough to its end to count as reading the newest line.
 *
 * Exported so it can be checked without mounting anything.
 */
export function isNearBottom(
  element: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 80,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
  );
}

/**
 * Whether the group chat moves to its newest line.
 *
 * Always on opening, and always for the person's own message: they just sent it and are looking for
 * it. A Bot's line only for a reader already at the bottom, so somebody reading an earlier answer
 * keeps their place.
 *
 * Exported so it can be checked without mounting anything.
 */
export function shouldFollowGroup({
  landed,
  atBottom,
  newestIsMine,
}: {
  landed: boolean;
  atBottom: boolean;
  newestIsMine: boolean;
}): boolean {
  return !landed || atBottom || newestIsMine;
}
