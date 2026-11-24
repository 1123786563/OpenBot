import {
  CopilotChatConfigurationProvider,
  UseAgentUpdate,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { whileObserved } from "@/lib/copilot/approval-context";
import { isBrokenStream, STREAM_BROKE } from "@/lib/copilot/broken-stream";
import { afterMs, joinWithin } from "@/lib/copilot/join-thread";
import { repairUnansweredToolCalls } from "@/lib/copilot/repair-history";
import { releaseServerOwnedInterrupts } from "@/lib/copilot/server-owned-interrupts";
import { followLastRun, stoppedReason } from "@/lib/copilot/stopped-turn";
import {
  readThreadMessages,
  withCurrentA2uiVersions,
} from "@/lib/copilot/thread-messages";
import { newId } from "@/lib/new-id";
import { mergeStoredMessages, toMessageContent } from "./channel-chat";
import type { ComposerDraft } from "./composer";
import { ConversationView } from "./conversation-view";

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

  /*
   * A turn that fails, kept where `send` can still see it. `copilotkit.runAgent` resolves as if it had
   * answered when the run fails, so this is the only way the composer learns that its words were not
   * sent and puts them back.
   *
   * Only a turn started here counts. The join replays runs that failed long ago, and how the last of
   * those ended is `lastRun`'s to say.
   */
  const failed = useRef<string | null>(null);
  const inTurn = useRef(false);
  useEffect(() => {
    const fail = (reason: string) => {
      if (!inTurn.current) return;
      failed.current = reason;
      setRunError(reason);
    };
    const subscription = agent.subscribe({
      onRunErrorEvent: ({ event }) => fail(stoppedReason(event?.message)),
      onRunFailed: ({ error }) =>
        fail(isBrokenStream(error) ? STREAM_BROKE : stoppedReason(error)),
      // A run the server stopped to ask the person draws its card now, not on the inbox's next read.
      onRunFinishedEvent: () =>
        void queryClient.invalidateQueries({ queryKey: ["approvals"] }),
    });
    return () => subscription.unsubscribe();
  }, [agent, queryClient]);

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
        const stored = await readThreadMessages(threadId, agentId);
        if (current && stored.availability === "ready") {
          const merged = mergeStoredMessages(
            withCurrentA2uiVersions(agent.messages),
            stored.messages,
          );
          if (merged !== agent.messages) agent.setMessages(merged);
        }
      } finally {
        // Cleared on failure too: placeholders promise messages that may never come.
        if (current) setRestoring(false);
      }
    })();
    // A connect left in flight is torn down by the next run, and ends by replacing the messages.
    return () => {
      current = false;
      void agent.detachActiveRun().catch(() => undefined);
    };
  }, [agent, agentId, copilotkit, isReady, threadId]);

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
    setRunError(null);
    inTurn.current = true;
    setSending(true);
    try {
      await copilotkit.runAgent({ agent });
    } finally {
      inTurn.current = false;
      setSending(false);
    }
    if (failed.current) throw new Error(failed.current);
  };
  return (
    <CopilotChatConfigurationProvider agentId={agentId} threadId={threadId}>
      <ConversationView
        busy={agent.isRunning || sending}
        draftStorageKey={draftKey}
        messages={agent.messages}
        onSubmit={send}
        onStop={() => copilotkit.stopAgent({ agent })}
        pending={agent.isRunning || sending}
        restoring={restoring}
        stoppable={agent.isRunning}
        threadId={threadId}
        {...(runError ? { stopped: runError } : {})}
      />
    </CopilotChatConfigurationProvider>
  );
}
