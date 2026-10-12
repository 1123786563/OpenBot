import { IconCircleX, IconClock } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
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
import {
  messagesToTranscript,
  type TranscriptItem,
  useBuildStreaming,
} from "@/lib/craft/streaming";
import { Composer } from "./composer";
import { MessagePlan } from "./message/plan";
import { MessageText } from "./message/text";
import { MessageThinking } from "./message/thinking";
import { ToolCall } from "./message/tool-call";
import { useWakeOnIntent } from "./sandbox-status-indicator";
import { ScheduledRunStatusChip } from "./scheduled-task-editor";

/**
 * The conversation: durable history first, then the live turn, then the composer. History and live
 * share one `TranscriptItem` shape (the packets are byte-identical), so one switch draws both; a
 * pending approval the turn is blocked on appears above the composer with its allow/deny verbs.
 *
 * A SCHEDULED-origin session additionally carries the run banner: the context read drives it, and
 * while the run is live the scheduled-run SSE feeds the same live list the interactive turns use
 * (onyx's shouldStreamScheduledRun, minus its input lock — recorded as a port difference).
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
    streamMessage,
    interruptStreaming,
    streamScheduledRunEvents,
  } = useBuildStreaming(sessionId);
  const shouldStreamScheduledRun = scheduledRun.data?.status === "running";
  // Focus on a sleeping sandbox is the wake signal (onyx's useWakeOnIntent): the composer's
  // textarea onFocus forces the session reload whose server side restores the snapshot.
  const wakeOnIntent = useWakeOnIntent(sessionId);

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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {messages.isPending && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("chat.loading")}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("chat.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.key}>
                <TranscriptEntry item={item} />
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
      <Composer
        sessionId={sessionId}
        disabled={messages.isPending}
        streaming={isStreaming}
        onSend={handleSend}
        onInterrupt={interruptStreaming}
        onInputFocus={wakeOnIntent}
      />
    </div>
  );
}

function TranscriptEntry({ item }: { item: TranscriptItem }) {
  const { t } = useTranslation("craft");
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-muted px-3 py-2 text-sm">
            {item.text ? (
              <p className="whitespace-pre-wrap">{item.text}</p>
            ) : null}
            {item.attachments && item.attachments.length > 0 ? (
              <ul
                className="mt-1 space-y-0.5"
                aria-label={t("attachments.list")}
              >
                {item.attachments.map((attachment) => (
                  <li
                    key={attachment.path}
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                  >
                    <span className="truncate">{attachment.name}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      );
    case "text":
      return <MessageText text={item.text} />;
    case "thinking":
      return <MessageThinking text={item.text} streaming={item.streaming} />;
    case "tool":
      return (
        <ToolCall
          title={item.title}
          toolKind={item.toolKind}
          status={item.status}
          rawInput={item.rawInput}
          rawOutput={item.rawOutput}
          content={item.content}
        />
      );
    case "plan":
      return <MessagePlan entries={item.entries} />;
    case "usage":
      return (
        <p className="text-center text-[11px] text-muted-foreground">
          {t("chat.usage", { tokens: item.usedTokens })}
        </p>
      );
    case "compaction":
      return (
        <p className="text-center text-[11px] text-muted-foreground">
          {t("chat.compacted")}
        </p>
      );
    case "error":
      return (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <IconCircleX className="size-3.5 shrink-0" />
          {item.message}
        </p>
      );
  }
}
