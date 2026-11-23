import { HStack, VStack } from "@astryxdesign/core/Stack";
import {
  type DirectChatDecision,
  directChatLearning,
  type LearningEvidenceSelection,
  type learningRequest,
} from "@openbot/shared/direct-chat-learning";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { client, tryClient } from "@/lib/client";
import { learningAnalysisReason } from "@/lib/learning/display";
import { learningKeys } from "@/lib/learning/queries";
import { recordingsQueryOptions } from "@/lib/recorder/queries";

type Analysis = NonNullable<z.infer<typeof directChatLearning>["latest"]>;

function inProgress(analysis: Analysis | null | undefined) {
  return analysis?.state === "running" || analysis?.state === "reconciling";
}

function analysisText(analysis: Analysis) {
  const count = analysis.evidenceCount;
  const scope = `${count} completed ${count === 1 ? "turn" : "turns"}`;
  if (analysis.state === "running") return `Analyzing ${scope}…`;
  if (analysis.state === "reconciling")
    return `Checking the model outcome for ${scope}…`;
  if (analysis.state === "proposed")
    return `Proposal ready for review from ${scope}.`;
  return (
    learningAnalysisReason(analysis.reason) ??
    "The analysis ended without a proposal."
  );
}

function LearningSources({
  agentId,
  threadId,
  selected,
  onChange,
}: {
  agentId: string;
  threadId: string;
  selected: LearningEvidenceSelection[];
  onChange: (value: LearningEvidenceSelection[]) => void;
}) {
  const conversations = useInfiniteQuery(channelListQueryOptions());
  const recordings = useInfiniteQuery(recordingsQueryOptions());
  const choices: { source: LearningEvidenceSelection; label: string }[] = [
    ...(conversations.data ?? [])
      .filter(
        (row) =>
          row.active &&
          row.agentIds.includes(agentId) &&
          row.threadId !== threadId,
      )
      .map((row) => ({
        source: { kind: "conversation" as const, id: row.id },
        label: row.summary ?? row.name,
      })),
    ...(recordings.data?.pages ?? []).flatMap((page) =>
      page.canManage
        ? page.recordings
            .filter((row) => row.ended === "succeeded")
            .map((row) => ({
              source: { kind: "recording" as const, id: row.id },
              label: row.title ?? new Date(row.recordedAt).toLocaleString(),
            }))
        : [],
    ),
  ];
  return (
    <fieldset className="space-y-2 rounded-md border p-3 text-sm">
      <legend className="px-1 font-medium">Learning sources</legend>
      <p>
        Choose up to 8 sources. Everyone in a shared conversation must allow its
        use.
      </p>
      {choices.map(({ source, label }) => {
        const checked = selected.some(
          (item) => item.kind === source.kind && item.id === source.id,
        );
        return (
          <label
            className="flex items-start gap-2"
            key={`${source.kind}:${source.id}`}
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={checked}
              disabled={!checked && selected.length >= 8}
              onChange={() =>
                onChange(
                  checked
                    ? selected.filter(
                        (item) =>
                          item.kind !== source.kind || item.id !== source.id,
                      )
                    : [...selected, source],
                )
              }
            />
            {source.kind === "recording" ? "Recording" : "Conversation"} ·{" "}
            {label}
          </label>
        );
      })}
      {(conversations.isPending || recordings.isPending) && (
        <p role="status">Loading sources…</p>
      )}
      {(conversations.isError || recordings.isError) && (
        <p role="alert">Some sources couldn't be loaded.</p>
      )}
      {!conversations.isPending &&
        !recordings.isPending &&
        choices.length === 0 && <p>No other sources available.</p>}
      {conversations.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={conversations.isFetchingNextPage}
          onClick={() => void conversations.fetchNextPage()}
        >
          More conversations
        </Button>
      )}
      {recordings.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={recordings.isFetchingNextPage}
          onClick={() => void recordings.fetchNextPage()}
        >
          More recordings
        </Button>
      )}
    </fieldset>
  );
}

export function DirectChatLearning({
  threadId,
  agentId,
  conversationTitle,
}: {
  threadId: string;
  agentId: string;
  conversationTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const base = `/api/copilotkit/threads/${encodeURIComponent(threadId)}/learn`;
  const query = `?agentId=${encodeURIComponent(agentId)}`;
  const path = base + query;
  const [chooseSources, setChooseSources] = useState(false);
  const [selected, setSelected] = useState<LearningEvidenceSelection[]>([]);
  const queryKey = [...learningKeys.directChat, threadId, agentId];
  const fromSettings = conversationTitle !== undefined;
  const status = useQuery({
    enabled: !fromSettings || open,
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await tryClient(path, { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Couldn't load Learning.");
      return directChatLearning.parse(await response.json());
    },
    refetchInterval: (query) =>
      open && inProgress(query.state.data?.latest)
        ? 1000
        : open && query.state.data?.schedule?.enabled
          ? 30_000
          : false,
    retry: false,
  });
  const start = useMutation({
    mutationFn: async (body: z.infer<typeof learningRequest>) => {
      const response = await client(path, {
        method: "POST",
        body,
        fallback: "Couldn't start Learning.",
      });
      return directChatLearning.parse(await response.json());
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const configure = useMutation({
    mutationFn: async (settings: {
      enabled: boolean;
      intervalHours: number;
    }) => {
      await client(path, {
        method: "PUT",
        body: settings,
        fallback: "Couldn't save scheduled Learning.",
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const review = useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: DirectChatDecision;
    }) =>
      client(`${base}/proposals/${encodeURIComponent(id)}${query}`, {
        method: "POST",
        body,
        fallback: "Couldn't save the review.",
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const autoApproval = useMutation({
    mutationFn: async (autoApprove: boolean) =>
      client(`${base}/auto-approval${query}`, {
        method: "POST",
        body: { autoApprove },
        fallback: "Couldn't save automatic approval.",
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.all }),
  });
  const data = status.data;
  if (!fromSettings && (!data || status.error)) return null;
  const working = inProgress(data?.latest);
  const last = data?.lastResult;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={
          fromSettings ? `Learning for ${conversationTitle}` : undefined
        }
        onClick={() => {
          start.reset();
          setSelected([]);
          setChooseSources(false);
          review.reset();
          autoApproval.reset();
          if (!fromSettings) void status.refetch();
          setOpen(true);
        }}
      >
        Learning
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {fromSettings
                ? `Learning for ${conversationTitle}`
                : "Learn from this conversation"}
            </DialogTitle>
            <DialogDescription>
              Analyze completed turns using Test Credits and draft a proposal
              for review.
            </DialogDescription>
          </DialogHeader>
          {status.error ? (
            <VStack gap={2}>
              <p role="alert">Couldn't load Learning.</p>
              <Button
                onClick={() => void status.refetch()}
                disabled={status.isFetching}
              >
                Retry
              </Button>
            </VStack>
          ) : status.isPending ? (
            <p role="status">Loading Learning…</p>
          ) : !data ? (
            <p role="status">
              Learning is no longer accessible for this conversation.
            </p>
          ) : (
            <>
              <VStack gap={2} className="text-sm" role="status">
                {!data.enabled && <p>Learning is disabled.</p>}
                {data.enabled && !data.available && (
                  <p>The Learning model is unavailable.</p>
                )}
                {working && data.latest && <p>{analysisText(data.latest)}</p>}
                {last && <p>Last result · {analysisText(last)}</p>}
              </VStack>
              {data.schedule && (
                <form
                  key={`${data.schedule.enabled}-${data.schedule.intervalHours}`}
                  className="space-y-2 rounded-md border p-3 text-sm"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    configure.mutate({
                      enabled: fields.has("enabled"),
                      intervalHours: Number(fields.get("intervalHours")),
                    });
                  }}
                >
                  <label className="flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      name="enabled"
                      defaultChecked={data.schedule.enabled}
                    />
                    Allow scheduled analysis to spend Test Credits
                  </label>
                  <label className="flex items-center gap-2">
                    Run every
                    <input
                      aria-label="Analysis interval in hours"
                      className="w-20 rounded border bg-background px-2 py-1"
                      type="number"
                      name="intervalHours"
                      min={1}
                      max={168}
                      step={1}
                      required
                      defaultValue={data.schedule.intervalHours}
                    />
                    hours
                  </label>
                  <p role="status">
                    {data.schedule.nextAt
                      ? `Next analysis · ${new Date(data.schedule.nextAt).toLocaleString()}`
                      : data.schedule.enabled
                        ? "Scheduled analysis is paused."
                        : "Scheduled analysis is off."}
                  </p>
                  {data.schedule.lastResult && (
                    <p>
                      Last scheduled result ·{" "}
                      {analysisText(data.schedule.lastResult)}
                    </p>
                  )}
                  {configure.error && (
                    <p className="text-destructive" role="alert">
                      {configure.error.message}
                    </p>
                  )}
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={configure.isPending}
                  >
                    Save schedule
                  </Button>
                </form>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={data.autoApprove}
                  disabled={autoApproval.isPending}
                  onChange={(event) =>
                    autoApproval.mutate(event.currentTarget.checked)
                  }
                />
                Automatically approve new proposals from this conversation.
                Skills are delivered here for this Bot.
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-expanded={chooseSources}
                onClick={() => {
                  if (chooseSources) setSelected([]);
                  setChooseSources(!chooseSources);
                }}
              >
                {chooseSources
                  ? "Use this conversation"
                  : "Choose other evidence"}
              </Button>
              {chooseSources && (
                <LearningSources
                  agentId={agentId}
                  threadId={threadId}
                  selected={selected}
                  onChange={setSelected}
                />
              )}
              {data.proposals.map((proposal) => (
                <article
                  key={proposal.id}
                  className="space-y-2 rounded-md border p-3 text-sm"
                >
                  <p className="text-xs text-muted-foreground">
                    {proposal.state === "pending_review" && "Pending review"}
                    {proposal.state === "published" &&
                      "Published for this conversation"}
                    {proposal.state === "rejected" && "Rejected"}
                    {proposal.state === "revision_required" &&
                      "Revision required"}
                    {proposal.state === "paused" && "Skill delivery paused"}
                    {proposal.revisionSubmitted && " · Revision submitted"}
                    {proposal.review?.mode === "automatic" &&
                      " · Automatically approved"}
                    {proposal.review &&
                      ` · ${new Date(proposal.review.reviewedAt).toLocaleString()}`}
                  </p>
                  <h3 className="font-medium break-words">{proposal.title}</h3>
                  <p className="whitespace-pre-wrap break-words">
                    {proposal.instructions}
                  </p>
                  <details>
                    <summary className="cursor-pointer">
                      Evidence ({proposal.evidence.length}{" "}
                      {proposal.evidence.length === 1 ? "turn" : "turns"})
                    </summary>
                    <ol className="mt-2 space-y-3">
                      {proposal.evidence.map((item) =>
                        "source" in item ? (
                          <li
                            key={`${item.source.kind}:${item.source.id}`}
                            className="space-y-1 border-l pl-3 break-words"
                          >
                            <p>
                              <strong>
                                {item.source.kind === "recording"
                                  ? "Recording"
                                  : "Conversation"}
                              </strong>{" "}
                              · {item.title}
                            </p>
                            <p className="whitespace-pre-wrap">
                              {item.excerpt}
                            </p>
                          </li>
                        ) : (
                          <li
                            key={item.runId}
                            className="space-y-1 border-l pl-3 break-words"
                          >
                            <p className="whitespace-pre-wrap">
                              <strong>You</strong> · {item.prompt}
                            </p>
                            <p className="whitespace-pre-wrap">
                              <strong>Bot</strong> · {item.reply}
                            </p>
                          </li>
                        ),
                      )}
                    </ol>
                  </details>
                  {(proposal.state === "paused" ||
                    proposal.state === "revision_required") &&
                    !proposal.revisionSubmitted &&
                    proposal.evidence.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          !data.enabled ||
                          !data.available ||
                          working ||
                          start.isPending
                        }
                        onClick={() =>
                          start.mutate({ revisesProposalId: proposal.id })
                        }
                      >
                        Resubmit remaining evidence
                      </Button>
                    )}
                  {proposal.state === "pending_review" && (
                    <HStack wrap="wrap" gap={2}>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={review.isPending}
                        onClick={() =>
                          review.mutate({
                            id: proposal.id,
                            body: { decision: "reject", scope: data.scope },
                          })
                        }
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        disabled={!data.enabled || review.isPending}
                        onClick={() =>
                          review.mutate({
                            id: proposal.id,
                            body: { decision: "approve", scope: data.scope },
                          })
                        }
                      >
                        Approve for this conversation
                      </Button>
                    </HStack>
                  )}
                </article>
              ))}
              {[start.error, review.error, autoApproval.error].map(
                (error) =>
                  error && (
                    <p
                      key={error.message}
                      className="text-sm text-destructive"
                      role="alert"
                    >
                      {error.message}
                    </p>
                  ),
              )}
              <DialogFooter>
                <Button
                  disabled={
                    !data.enabled ||
                    !data.available ||
                    working ||
                    start.isPending ||
                    (chooseSources && !selected.length)
                  }
                  onClick={() =>
                    start.mutate(chooseSources ? { evidence: selected } : {})
                  }
                >
                  Learn now
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
