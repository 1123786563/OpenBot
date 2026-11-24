import { Button as RecoveryButton } from "@astryxdesign/core/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type MouseEvent,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { z } from "zod";
import {
  QuestionNotice,
  type WaitingQuestion,
} from "@/components/approvals/question-notice";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  type ApprovalInboxData,
  answerPersonQuestionMutationOptions,
  approvalInboxOptions,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  composeDraftKey,
  readComposeDraft,
  writeComposeDraft,
} from "@/lib/channels/compose-draft";
import { canKeepCachedRead, client } from "@/lib/client";
import {
  awaitingFirstReply,
  type GroupBackgroundRun,
  type GroupMessage,
  groupKeys,
  groupQueryOptions,
  sendGroupMessageMutationOptions,
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
} from "./conversation-status";
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
  const stopRun = useMutation({
    mutationFn: async (run: GroupBackgroundRun) => {
      await client(
        `/api/copilotkit/threads/${encodeURIComponent(run.threadId)}/runs/${encodeURIComponent(run.id)}/stop?agentId=${encodeURIComponent(run.agentId)}`,
        { method: "POST", fallback: "The Bot run could not be stopped." },
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: groupKeys.detail(channelId) }),
  });
  const working =
    background.some(({ status }) => status === "running") ||
    messages.some(
      (message) => message.status === "running" || message.status === "queued",
    );

  const inbox = useQuery(approvalInboxOptions());
  const question = groupQuestion(inbox.data, channelId);
  // The Bot whose conversation it is: for a hand-off, the one that handed the work on.
  const askerId = question?.conversationBotId ?? question?.botId;
  const asker = useQuery(agentListQueryOptions()).data?.find(
    (bot) => bot.id === askerId,
  );
  const answer = useMutation(answerPersonQuestionMutationOptions(queryClient));
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
    newest?.agentId === null && bots.length > 0 && !question;
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
  if (!group.data || !canKeepCachedRead(group.error)) {
    return (
      <Stack padding={5}>
        <ConversationReadError
          title={
            canKeepCachedRead(group.error)
              ? "Couldn't open this group conversation."
              : "You can't access this group conversation."
          }
          description="The messages and participant list are unavailable."
          retry={() => void group.refetch()}
          retryBelow
          retrying={group.isFetching}
        />
      </Stack>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          {messages.length === 0 && background.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Say something to {bots.map((bot) => bot.name).join(" and ")}.
              Every Bot answers in turn; start with @Name to ask just one.
            </p>
          ) : null}
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
              mine={message.ownerUserId === me?.id}
              available={message.agentId !== null && names.has(message.agentId)}
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
              <MessageContent>
                <strong>{names.get(run.agentId)}</strong>
                {run.partialReply && (
                  <p className="whitespace-pre-wrap">{run.partialReply}</p>
                )}
                <p>
                  {run.reason ??
                    (run.waitingForApproval
                      ? "Waiting for your approval."
                      : run.status === "running"
                        ? "Running"
                        : run.status === "completed"
                          ? "Run completed"
                          : run.externalOutcome !== "unknown"
                            ? "Run ended"
                            : null)}
                  {run.externalOutcome === "unknown" &&
                    " The external outcome needs verification."}
                </p>
              </MessageContent>
              {run.waitingForApproval && (
                <Button
                  disabled={stopRun.isPending}
                  onClick={() => stopRun.mutate(run)}
                  size="sm"
                  variant="ghost"
                >
                  Stop run
                </Button>
              )}
            </MessageRow>
          ))}
          {stopRun.error && <p role="alert">{stopRun.error.message}</p>}
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
        {send.error ? (
          <p className="px-4 pb-2 text-sm text-destructive" role="alert">
            Couldn't confirm your message was sent. Your draft is still here.
            Send it again to retry.
          </p>
        ) : null}
        {answer.error ? (
          <p className="px-4 pb-2 text-sm text-destructive" role="alert">
            Couldn't confirm your answer. Check whether the question is still
            waiting before replying again.
          </p>
        ) : null}
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
        {!question ? (
          <Stack
            style={{
              paddingInline: "var(--spacing-4)",
              paddingBlockEnd: "var(--spacing-2)",
            }}
          >
            <Text as="p" type="supporting">
              {bots.length === 0
                ? "No Bots are available to reply."
                : bots.length === 1
                  ? `Replies come from ${bots[0]?.name}.`
                  : "All Bots reply in order. Type @ to ask one Bot."}
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
    </div>
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
  rememberActivityLink,
}: {
  message: GroupMessage;
  name: string;
  answeredBy?: string;
  mine: boolean;
  rowRef?: Ref<HTMLDivElement>;
  available: boolean;
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
        <ChannelAvatar participantIds={[message.agentId]} size={24} />
      </div>
      <MessageContent>
        <MessageHeader className="text-xs font-medium text-muted-foreground">
          {name}
          {answeredBy ? ` · answer from ${answeredBy}` : null}
        </MessageHeader>
        {(message.status === "running" || message.status === "queued") &&
        !message.text ? (
          <p
            className="tool-line-running text-sm text-muted-foreground"
            role="status"
          >
            {message.status === "queued" ? "Waiting to reply" : "Thinking"}
          </p>
        ) : message.status === "waiting" ? (
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
