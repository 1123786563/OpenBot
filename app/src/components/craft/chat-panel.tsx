import { IconClock } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { decideCraftApproval, listLiveApprovals } from "@/lib/craft/client";
import {
  craftKeys,
  craftMessagesQueryOptions,
  craftSessionQueryOptions,
} from "@/lib/craft/queries";
import {
  isScheduledRunInFlight,
  scheduledRunContextKey,
  scheduledRunContextQueryOptions,
} from "@/lib/craft/scheduled-tasks";
import { messagesToTranscript, useBuildStreaming } from "@/lib/craft/streaming";
import { Composer } from "./composer";
import { TranscriptEntry } from "./message/transcript-entry";
import { useWakeOnIntent } from "./sandbox-status-indicator";
import { ScheduledRunStatusChip } from "./scheduled-task-editor";
import { SubagentView } from "./subagent-view";

/**
 * The conversation: durable history first, then the live turn, then the composer. History and live
 * share one `TranscriptItem` shape (the packets are byte-identical), so one switch draws both; a
 * pending approval the turn is blocked on appears above the composer with its allow/deny verbs.
 *
 * A SCHEDULED-origin session additionally carries the run banner: the context read drives it, and
 * while the run is live the scheduled-run SSE feeds the same live list the interactive turns use
 * (onyx's shouldStreamScheduledRun, minus its input lock — recorded as a port difference).
 *
 * The main area also swaps between the conversation and a subagent's read-only transcript
 * (`viewedSubagentId`, onyx's viewedSubagentSessionId minus the cross-fade): the `task` tool
 * card's click-through sets it, the view's return button clears it, and the composer is hidden
 * while a subagent is on screen so the pane is unambiguously read-only.
 */
export function ChatPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const queryClient = useQueryClient();
  const messages = useQuery(craftMessagesQueryOptions(sessionId));
  const approvals = useQuery({
    queryKey: ["craft", "approvals", sessionId],
    queryFn: () => listLiveApprovals(sessionId),
    refetchInterval: 5000,
  });
  const session = useQuery(craftSessionQueryOptions(sessionId));
  // Gate on origin so interactive sessions never ask for a context they cannot have.
  const isScheduledSession = session.data?.origin === "SCHEDULED";
  const scheduledRun = useQuery({
    ...scheduledRunContextQueryOptions(sessionId),
    enabled: isScheduledSession,
  });
  const {
    items: liveItems,
    isStreaming,
    subagents,
    streamMessage,
    interruptStreaming,
    streamScheduledRunEvents,
  } = useBuildStreaming(sessionId);
  const shouldStreamScheduledRun = scheduledRun.data?.status === "running";
  // Focus on a sleeping sandbox is the wake signal (onyx's useWakeOnIntent): the composer's
  // textarea onFocus forces the session reload whose server side restores the snapshot.
  const wakeOnIntent = useWakeOnIntent(sessionId);

  // The subagent view is session-scoped: switching sessions mid-mount (the route keeps this
  // panel alive) drops the viewer back to the conversation — the render-time reset, so no
  // stale subagent id outlives its session.
  const [viewedSubagentId, setViewedSubagentId] = useState<string | null>(null);
  const [subagentViewSessionId, setSubagentViewSessionId] = useState(sessionId);
  if (subagentViewSessionId !== sessionId) {
    setSubagentViewSessionId(sessionId);
    setViewedSubagentId(null);
  }
  const viewedSubagent =
    viewedSubagentId !== null
      ? (subagents.get(viewedSubagentId) ?? null)
      : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const historyItems = messagesToTranscript(messages.data ?? []);
  const items = isStreaming ? [...historyItems, ...liveItems] : historyItems;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && (isStreaming || items.length > 0)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items.length, isStreaming]);

  // Auto-attach to the live scheduled run (onyx's effect, simplified): one stream per run, ended
  // by its terminal frame or the server's run-resolved close, then the durable rows refresh.
  useEffect(() => {
    if (!isScheduledSession || !shouldStreamScheduledRun) return;
    let cancelled = false;
    void (async () => {
      await streamScheduledRunEvents();
      if (cancelled) return;
      await queryClient.invalidateQueries({
        queryKey: craftKeys.messages(sessionId),
      });
      await queryClient.invalidateQueries({
        queryKey: scheduledRunContextKey(sessionId),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isScheduledSession,
    shouldStreamScheduledRun,
    streamScheduledRunEvents,
    queryClient,
    sessionId,
  ]);

  const handleSend = async (
    content: string,
    attachments?: { name: string; path: string; mime_type: string }[],
  ) => {
    await streamMessage(content, attachments);
    await queryClient.invalidateQueries({
      queryKey: craftKeys.messages(sessionId),
    });
    await queryClient.invalidateQueries({
      queryKey: craftKeys.artifacts(sessionId),
    });
    await queryClient.invalidateQueries({
      queryKey: craftKeys.session(sessionId),
    });
  };

  const decide = async (
    approvalId: string,
    decision: "allow_once" | "deny",
  ) => {
    await decideCraftApproval(approvalId, decision);
    await queryClient.invalidateQueries({
      queryKey: ["craft", "approvals", sessionId],
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isScheduledSession &&
      scheduledRun.data &&
      isScheduledRunInFlight(scheduledRun.data) ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-4 py-2">
          <IconClock className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">
            {scheduledRun.data.status === "running"
              ? t("banner.running", { name: scheduledRun.data.task_name })
              : scheduledRun.data.status === "awaiting_approval"
                ? t("banner.awaitingApproval", {
                    name: scheduledRun.data.task_name,
                  })
                : t("banner.queued", {
                    name: scheduledRun.data.task_name,
                  })}
          </span>
          <ScheduledRunStatusChip status={scheduledRun.data.status} />
        </div>
      ) : null}
      {viewedSubagent ? (
        <SubagentView
          subagent={viewedSubagent}
          onReturn={() => setViewedSubagentId(null)}
        />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {messages.isPending && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("chat.loading")}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("chat.empty")}</p>
          ) : (
            <ul className="space-y-3">
              {items.map((item) => (
                <li key={item.key}>
                  <TranscriptEntry
                    item={item}
                    onViewSubagent={setViewedSubagentId}
                  />
                </li>
              ))}
            </ul>
          )}

          {approvals.data && approvals.data.length > 0 ? (
            <div className="mt-4 rounded-md border border-border p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t("approvals.waiting")}
              </p>
              <ul className="space-y-2">
                {approvals.data.map((approval) => (
                  <li
                    key={approval.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate text-sm">
                      {approval.action.effect || approval.action.tool_ref}
                    </span>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void decide(approval.id, "allow_once")}
                      >
                        {t("approvals.allowOnce")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void decide(approval.id, "deny")}
                      >
                        {t("approvals.deny")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
      {viewedSubagent ? null : (
        <Composer
          sessionId={sessionId}
          disabled={messages.isPending}
          streaming={isStreaming}
          onSend={handleSend}
          onInterrupt={interruptStreaming}
          onInputFocus={wakeOnIntent}
        />
      )}
    </div>
  );
}
