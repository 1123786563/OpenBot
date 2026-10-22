import {
  IconChartBar,
  IconClock,
  IconLayout,
  IconTool,
  IconWand,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  decideCraftApproval,
  generateSessionName,
  listLiveApprovals,
} from "@/lib/craft/client";
import {
  invalidateCraftInScope,
  scopedCraftMessagesQueryOptions,
  scopedCraftSessionQueryOptions,
} from "@/lib/craft/queries";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  isScheduledRunInFlight,
  scopedScheduledRunContextQueryOptions,
} from "@/lib/craft/scheduled-tasks";
import type { CraftScheduledRunContext } from "@/lib/craft/types";
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
 *
 * The first-run moment: a fresh session's empty transcript is the product's front door, so it
 * carries the craft glyph, one sentence of what happens here, and three suggestion pills that
 * pre-fill (never send) the composer — the person keeps the trigger.
 */
const SUGGESTIONS = [
  { icon: IconLayout, key: "chat.suggest.landing" },
  { icon: IconTool, key: "chat.suggest.tool" },
  { icon: IconChartBar, key: "chat.suggest.report" },
] as const;
export function ChatPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const queryClient = useQueryClient();
  // The conversation's reads and writes are the scope's own (MT091 / Issue #134): the history,
  // the session facts, the live approvals and the scheduled-run banner all carry the selection
  // pair and file under the scope's cache prefix.
  const scope = useScopedCache();
  const pair = scope.status === "open" ? (scope.selection ?? {}) : undefined;
  const messages = useQuery(
    scopedCraftMessagesQueryOptions(queryClient, scope, sessionId),
  );
  const approvals = useQuery({
    queryKey: [
      ...(scope.status === "open" ? scope.prefix : []),
      "craft",
      "approvals",
      sessionId,
    ],
    enabled: scope.status === "open",
    queryFn: () => listLiveApprovals(sessionId, undefined, pair),
    refetchInterval: 5000,
  });
  const session = useQuery(
    scopedCraftSessionQueryOptions(queryClient, scope, sessionId),
  );
  // Gate on origin so interactive sessions never ask for a context they cannot have.
  const isScheduledSession = session.data?.origin === "SCHEDULED";
  const scheduledRun = useQuery<CraftScheduledRunContext | null>({
    ...scopedScheduledRunContextQueryOptions(queryClient, scope, sessionId),
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
  // The suggestion pills' half of the composer seam: they write the draft and bump the focus
  // signal; the composer owns the textarea, so the fill lands ready to edit, never sent.
  const [draft, setDraft] = useState("");
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);

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
      // The durable rows refresh at BOTH roots (MT091): the run's messages, its banner
      // context and any web app it scaffolded all live under the craft tree.
      invalidateCraftInScope(queryClient, scope);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isScheduledSession,
    shouldStreamScheduledRun,
    streamScheduledRunEvents,
    queryClient,
    scope,
  ]);

  const handleSend = async (
    content: string,
    attachments?: { name: string; path: string; mime_type: string }[],
  ) => {
    // onyx's naming trigger, FE-shaped: an unnamed session is titled by the LLM once its
    // first user message is durable. onSent fires after send-message persisted the row (so
    // the naming read always sees it), and the generation races the turn — the sidebar's
    // title lands in seconds, not at turn end. A session the person already named is never
    // re-titled, and a failed generation stays silent: naming is best-effort and the next
    // send of an unnamed session retries it.
    const unnamed = session.data?.name == null;
    await streamMessage(content, attachments, () => {
      if (!unnamed) return;
      void generateSessionName(sessionId, pair)
        .then(() => {
          invalidateCraftInScope(queryClient, scope);
        })
        .catch(() => undefined);
    });
    // A turn is the only thing that can start (or crash) the session's dev
    // server, so turn end is when the preview's `has_webapp`/`ready` facts
    // change. Without this the pane kept serving the pre-turn read and showed
    // "waiting for the first web app" beside an app the agent had just built.
    invalidateCraftInScope(queryClient, scope);
  };

  const decide = async (
    approvalId: string,
    decision: "allow_once" | "deny",
  ) => {
    // The decision is an execution action under the scope in force (MT091 AC3).
    await decideCraftApproval(approvalId, decision, pair);
    await queryClient.invalidateQueries({
      queryKey: ["craft", "approvals", sessionId],
    });
    if (scope.status === "open") {
      await queryClient.invalidateQueries({
        queryKey: [...scope.prefix, "craft", "approvals", sessionId],
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {isScheduledSession &&
      scheduledRun.data &&
      isScheduledRunInFlight(scheduledRun.data) ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-ob-muted-surface/40 px-4 py-2">
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
            <div className="flex h-full flex-col items-center justify-center gap-6 px-6 py-10 text-center">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card shadow-sm">
                <IconWand className="size-5 text-muted-foreground" />
              </div>
              <div className="space-y-2">
                <h2 className="text-lg font-semibold tracking-tight">
                  {t("chat.emptyTitle")}
                </h2>
                <p className="mx-auto max-w-[52ch] text-sm leading-relaxed text-muted-foreground">
                  {t("chat.emptyHint")}
                </p>
              </div>
              <div className="flex max-w-[60ch] flex-wrap items-center justify-center gap-2">
                {SUGGESTIONS.map(({ icon: Icon, key }, index) => (
                  <button
                    key={key}
                    type="button"
                    className="flex animate-in fade-in slide-in-from-bottom-1 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs text-muted-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-input hover:text-foreground hover:shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    style={{
                      animationDelay: `${index * 50}ms`,
                      animationFillMode: "backwards",
                    }}
                    onClick={() => {
                      setDraft(t(key));
                      setComposerFocusSignal((n) => n + 1);
                    }}
                  >
                    <Icon className="size-3.5" />
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
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
          draft={draft}
          onDraftChange={setDraft}
          focusSignal={composerFocusSignal}
        />
      )}
    </div>
  );
}
