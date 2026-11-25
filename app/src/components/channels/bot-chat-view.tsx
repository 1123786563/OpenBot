import {
  CopilotChatConfigurationProvider,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { HandoffResumeNotice } from "@/components/computer/handoff-resume-notice";
import { approvalInboxOptions, carryingOnQueryOptions } from "@/lib/approvals";
import { whileObserved } from "@/lib/copilot/approval-context";
import { isBrokenStream, STREAM_BROKE } from "@/lib/copilot/broken-stream";
import { afterMs, joinWithin } from "@/lib/copilot/join-thread";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { releaseServerOwnedInterrupts } from "@/lib/copilot/server-owned-interrupts";
import { followLastRun, stoppedReason } from "@/lib/copilot/stopped-turn";
import {
  readThreadMessages,
  type StoredThread,
  withCurrentA2uiVersions,
} from "@/lib/copilot/thread-messages";
import { newId } from "@/lib/new-id";
import { mergeStoredMessages, toMessageContent } from "./channel-chat";
import type { ComposerDraft } from "./composer";
import {
  ConversationAccessEnded,
  ConversationReadError,
} from "./conversation-status";
import { ConversationView } from "./conversation-view";
import { STOP_REFUSED, StoredRunNotice, stopStoredRun } from "./stored-run";

/** How long a stalled thread join is worth waiting for before it is ended. See `join-thread.ts`. */
const JOIN_DEADLINE_MS = 1500;

/**
 * One Bot's direct chat (`/bot`): the same transcript, composer, tool cards and approval cards a
 * Conversation draws, over the thread `useBotThread` remembers for this Bot.
 *
 * It binds the shared agent for its Bot, as the packaged chat did, so the Activity pane and the Bot's
 * own tools see the same runs. What the packaged chat did inside itself is done here: join the thread
 * (which replays it, its last run's failure included), read what the thread store holds, and run a
 * turn when the composer sends.
 */
export function BotChatView({
  agentId,
  draftKey,
  threadId,
}: {
  agentId: string;
  /** Where the composer keeps an unsent draft, per Bot and per signed-in person. */
  draftKey?: string;
  threadId: string;
}) {
  const { copilotkit } = useCopilotKit();
  const queryClient = useQueryClient();
  const { agent, isReady } = useAgent({
    agentId,
    updates: [
      UseAgentUpdate.OnMessagesChanged,
      UseAgentUpdate.OnRunStatusChanged,
    ],
  });
  /** History has been asked for and has not arrived. */
  const [restoring, setRestoring] = useState(isReady);
  /** Why the last turn ended without an answer, drawn at the end of the transcript. */
  const [runError, setRunError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  /**
   * What the last read of the thread found. `"failed"` is a read that could not be completed; the
   * transcript already on screen and the draft stay where they are. `"access-ended"` is a read the
   * server refused after one had succeeded, which is evidence the thread is no longer this person's.
   */
  const [history, setHistory] = useState<"ready" | "failed" | "access-ended">(
    "ready",
  );
  const [retrying, setRetrying] = useState(false);
  /** The runs the last ready read named, for the notice that says what became of them. */
  const [storedRuns, setStoredRuns] = useState<StoredThread["runs"]>();
  /** Whether any read of this thread has come back ready. See `applyRead`. */
  const readReady = useRef(false);
  /** The person stopped this turn, so however its run ends is not a failure. */
  const personStopped = useRef(false);
  /** A Stop is being asked of the server: a second press would ask again for the same run. */
  const [stopping, setStopping] = useState(false);

  /*
   * A turn that fails, kept where `send` can still see it. `copilotkit.runAgent` resolves as if it had
   * answered when the run fails, so this is the only way the composer learns that its words were not
   * sent and puts them back.
   *
   * Only a turn started here counts. The join replays runs that failed long ago, and how the last of
   * those ended is `lastRun`'s to say. A run the person stopped ends through here too, and is not a
   * failure: nothing was refused.
   */
  const failed = useRef<string | null>(null);
  const inTurn = useRef(false);
  useEffect(() => {
    const fail = (reason: string) => {
      if (!inTurn.current || personStopped.current) return;
      failed.current = reason;
      setRunError(reason);
    };
    const subscription = agent.subscribe({
      // A run the server stopped at the person's request is not a failure, pressed here or in
      // another tab: the notice says so from the read after the turn.
      onRunErrorEvent: ({ event }) => {
        if (event?.code !== "stopped") fail(stoppedReason(event?.message));
      },
      onRunFailed: ({ error }) =>
        fail(isBrokenStream(error) ? STREAM_BROKE : stoppedReason(error)),
      // A run the server stopped to ask the person draws its card now, not on the inbox's next read.
      onRunFinishedEvent: () =>
        void queryClient.invalidateQueries({ queryKey: ["approvals"] }),
    });
    return () => subscription.unsubscribe();
  }, [agent, queryClient]);

  /**
   * Take what a read found into the transcript, and say what it came to.
   *
   * A `/bot` thread has no conversation behind it until its first run is stored, and the history
   * route answers 404 for a thread it does not know, which the reader reports as access denied. That
   * 404 is ordinary: nothing was lost and there is nothing to load, so it is said only once a read of
   * the thread has succeeded. The same answer after one did means the thread was taken away, and
   * whatever was read of it goes with it.
   */
  const applyRead = useCallback(
    (stored: StoredThread) => {
      if (stored.availability === "ready") {
        readReady.current = true;
        setHistory("ready");
        setStoredRuns(stored.runs);
        // A live stream owns its transcript until it ends, as a Conversation's later reads hold.
        if (stored.runs && agent.isRunning) return;
        const merged = mergeStoredMessages(
          withCurrentA2uiVersions(agent.messages),
          stored.messages,
        );
        if (merged !== agent.messages) agent.setMessages(merged);
        return;
      }
      if (stored.accessDenied) {
        if (!readReady.current) return;
        setHistory("access-ended");
        setStoredRuns([]);
        agent.setMessages([]);
        void queryClient.invalidateQueries(approvalInboxOptions());
        return;
      }
      setHistory("failed");
    },
    [agent, queryClient],
  );

  /** Only the newest read owns the transcript; an older one that arrives late is dropped. */
  const readVersion = useRef(0);
  /**
   * Whether this view is still on screen. The Bot's agent is one object whoever's chat shows it, so
   * work that outlives this view — a turn's read — checks this before it touches the agent.
   */
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);
  const readHistory = useCallback(async () => {
    const version = ++readVersion.current;
    const stored = await readThreadMessages(threadId, agentId);
    if (version === readVersion.current && onScreen.current) applyRead(stored);
  }, [agentId, applyRead, threadId]);

  // Join the thread, restore what it holds, then the transcript is this Bot's.
  useEffect(() => {
    if (!isReady) return;
    let current = true;
    agent.threadId = threadId;
    // Before the connect: it is handed the subscribers the agent has when it starts.
    const lastRun = followLastRun(agent);
    setRestoring(true);
    void (async () => {
      let joined: "connected" | "deadline" = "deadline";
      try {
        joined = await joinWithin({
          connect: whileObserved(agent, () =>
            copilotkit.connectAgent({ agent }),
          ),
          deadline: afterMs(JOIN_DEADLINE_MS),
          detach: () => agent.detachActiveRun(),
          answering: () => lastRun.running(),
        });
      } catch {
        // A join that throws is over. History is restored below either way.
      } finally {
        lastRun.stop();
      }
      // Only from a replay that finished: one ended at the deadline may stop short of the run that
      // answered, and a stale failure is worse than none.
      const earlier = joined === "connected" ? lastRun.failure() : null;
      if (current && earlier !== null) setRunError(earlier);
      try {
        await readHistory();
      } finally {
        // Cleared on failure too: placeholders promise messages that may never come.
        if (current) setRestoring(false);
      }
    })();
    // A connect left in flight is torn down by the next run, and ends by replacing the messages.
    return () => {
      current = false;
      readVersion.current += 1;
      void agent.detachActiveRun().catch(() => undefined);
    };
  }, [agent, copilotkit, isReady, readHistory, threadId]);

  /*
   * THE SERVER HAS THE TURN. After the person decides an approval, the run that asked ended here on
   * the interrupt, and the server runs the action and carries the conversation on in a turn no
   * browser streams. Nothing above sees it, so a conversation with one Bot showed "Thinking" from
   * this same record (`channel-chat.tsx`), and `/bot` sat idle with no sign of the Bot still working.
   *
   * Read from the approval itself, which the server marks `completed` only once that turn has ended.
   * When it does, the read is taken again so the reply the turn wrote is on screen without reopening.
   */
  const carryingOn = useQuery(carryingOnQueryOptions(threadId)).data === true;
  const wasCarryingOn = useRef(false);
  useEffect(() => {
    if (wasCarryingOn.current && !carryingOn) void readHistory();
    wasCarryingOn.current = carryingOn;
  }, [carryingOn, readHistory]);

  const retryRead = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await readHistory();
    } finally {
      setRetrying(false);
    }
  };

  const send = async (draft: ComposerDraft) => {
    /*
     * Two things a Conversation does before a turn, and for the same reasons. An approval the server
     * is waiting on is replayed as an interrupt the agent keeps, and the run after it is refused
     * before it leaves the browser (`server-owned-interrupts.ts`). And a provider rejects a turn sent
     * under a tool call with no result (`repair-history.ts`).
     */
    releaseServerOwnedInterrupts(agent);
    const repaired = repairUnansweredToolCalls(agent.messages);
    if (repaired !== agent.messages)
      agent.setMessages(repaired as typeof agent.messages);
    agent.addMessage({
      id: newId(),
      role: "user",
      content: toMessageContent(draft.text, draft.attachments),
    });
    failed.current = null;
    personStopped.current = false;
    setRunError(null);
    inTurn.current = true;
    setSending(true);
    try {
      await copilotkit.runAgent({ agent });
    } finally {
      inTurn.current = false;
      setSending(false);
    }
    /*
     * READ WHAT THE SERVER HOLDS OF THE THREAD AFTER EVERY TURN OF THIS TAB, answered or not, as a
     * conversation does. A read that lands while the Bot is replying merges nothing (`applyRead`),
     * and nothing else reads when a run ends: a stopped run's notice outlived the turn that
     * answered after it, and earlier messages a failed opening read had left out never arrived.
     * After a turn that failed, the same read is what puts an outcome to check, or the way back,
     * on screen at once rather than at some later read.
     */
    void readHistory();
    if (failed.current) throw new Error(failed.current);
  };

  /*
   * STOP READS THE THREAD FIRST, THEN STOPS THE RUN THE READ NAMES (`stopStoredRun`). Stopping only
   * this browser's copy left the Bot working, and posting the id from the opening read stopped a run
   * that had already ended while the one going went on.
   *
   * Only the server's own word is a stop, and it is the read after it that says "The run was
   * stopped.", from the stored run. A run that was already over is let go here without a word
   * claiming a stop.
   *
   * A REFUSAL STOPS NOTHING, and ends nothing here. It used to abort this browser's copy of the run
   * too, so the Bot went on working on the server while its reply stopped arriving, and Stop went
   * with the run: "Try again" pointed at a button that was no longer there. The run keeps streaming
   * and Stop stays for another press, as in a conversation. And the rest of the run is nobody's
   * stop: a failure in it is still a failure.
   *
   * Not offered while the server carries a turn on (`stoppable` is this tab's run alone): there is
   * no run here to reach, and a Stop that does nothing is worse than none.
   */
  const stop = async () => {
    if (stopping) return;
    personStopped.current = true;
    setStopping(true);
    try {
      const outcome = await stopStoredRun(threadId, agentId);
      if (outcome === "refused") {
        personStopped.current = false;
        setRunError(STOP_REFUSED);
      } else {
        // A refusal from an earlier press of this run is old news once the server answers.
        setRunError(null);
        if (outcome === "ended") copilotkit.stopAgent({ agent });
      }
      // What the run said before the Stop is stored; read it so it is on screen.
      await readHistory();
    } finally {
      setStopping(false);
    }
  };

  if (history === "access-ended") return <ConversationAccessEnded />;

  return (
    <CopilotChatConfigurationProvider agentId={agentId} threadId={threadId}>
      <ConversationView
        busy={agent.isRunning || sending || carryingOn}
        draftStorageKey={draftKey}
        messages={agent.messages}
        notice={
          <>
            <HandoffResumeNotice
              agent={agent}
              botId={agentId}
              ready={isReady && !restoring}
              run={async () => {
                await whileObserved(agent, () =>
                  copilotkit.runAgent({ agent }),
                );
              }}
            />
            <StoredRunNotice
              agentId={agentId}
              onChecked={(refused) => {
                // The outcome is settled, so the failure that pointed at it is old news.
                if (!refused) setRunError(null);
                void readHistory();
              }}
              runs={storedRuns}
              threadId={threadId}
            />
            {history === "failed" ? (
              <ConversationReadError
                description="You can keep using this conversation."
                retry={retryRead}
                retrying={retrying}
                title="Couldn't load earlier messages."
              />
            ) : null}
          </>
        }
        onSubmit={send}
        onStop={() => void stop()}
        pending={agent.isRunning || sending || carryingOn}
        restoring={restoring}
        stoppable={agent.isRunning && !stopping}
        threadId={threadId}
        {...(runError ? { stopped: runError } : {})}
      />
    </CopilotChatConfigurationProvider>
  );
}
