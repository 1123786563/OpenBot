import { directChatLearning } from "@openbot/shared/direct-chat-learning";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { client, tryClient } from "@/lib/client";

type Analysis = NonNullable<z.infer<typeof directChatLearning>["latest"]>;

const reasons: Record<string, string> = {
  insufficient_credits: "There are not enough Test Credits.",
  execution_limit: "The Test Credit limit was reached.",
  not_authorized: "Authorization to analyze or spend Test Credits was lost.",
  route_unavailable: "The model route is unavailable.",
  unavailable: "Test Credit admission is unavailable.",
  no_evidence: "There are no completed turns to analyze.",
  no_procedure: "No reusable procedure was found.",
  invalid_model_result: "The model returned an invalid proposal.",
  analysis_interrupted: "The analysis was interrupted.",
  learning_disabled: "Learning was turned off.",
  evidence_unavailable: "The conversation evidence is unavailable.",
};

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
    reasons[analysis.reason ?? ""] ?? "The analysis ended without a proposal."
  );
}

export function DirectChatLearning({
  threadId,
  agentId,
}: {
  threadId: string;
  agentId: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const path = `/api/copilotkit/threads/${encodeURIComponent(threadId)}/learn?agentId=${encodeURIComponent(agentId)}`;
  const queryKey = ["direct-chat-learning", threadId, agentId];
  const status = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await tryClient(path, { signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Couldn't load Learning.");
      return directChatLearning.parse(await response.json());
    },
    refetchInterval: (query) =>
      open && inProgress(query.state.data?.latest) ? 1000 : false,
    retry: false,
  });
  const start = useMutation({
    mutationFn: async () => {
      const response = await client(path, {
        method: "POST",
        body: {},
        fallback: "Couldn't start Learning.",
      });
      return directChatLearning.parse(await response.json());
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const data = status.data;
  if (!data || status.error) return null;
  const working = inProgress(data.latest);
  const last = data.lastResult;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          start.reset();
          void status.refetch();
          setOpen(true);
        }}
      >
        Learning
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Learn from this conversation</DialogTitle>
            <DialogDescription>
              Analyze completed turns using Test Credits and draft a proposal
              for review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm" role="status">
            {!data.enabled && <p>Learning is disabled.</p>}
            {data.enabled && !data.available && (
              <p>The Learning model is unavailable.</p>
            )}
            {working && data.latest && <p>{analysisText(data.latest)}</p>}
            {last && <p>Last result · {analysisText(last)}</p>}
          </div>
          {data.proposals.map((proposal) => (
            <article
              key={proposal.id}
              className="space-y-2 rounded-md border p-3 text-sm"
            >
              <p className="text-xs text-muted-foreground">Pending review</p>
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
                  {proposal.evidence.map(({ runId, prompt, reply }) => (
                    <li
                      key={runId}
                      className="space-y-1 border-l pl-3 break-words"
                    >
                      <p className="whitespace-pre-wrap">
                        <strong>You</strong> · {prompt}
                      </p>
                      <p className="whitespace-pre-wrap">
                        <strong>Bot</strong> · {reply}
                      </p>
                    </li>
                  ))}
                </ol>
              </details>
            </article>
          ))}
          {start.error && (
            <p className="text-sm text-destructive" role="alert">
              {start.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              disabled={
                !data.enabled || !data.available || working || start.isPending
              }
              onClick={() => start.mutate()}
            >
              Learn now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
