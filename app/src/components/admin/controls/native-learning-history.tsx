import { VStack } from "@astryxdesign/core/Stack";
import {
  type adminLearningDecision,
  adminLearningHistory,
} from "@openbot/shared/direct-chat-learning";
import { IconHistory } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { z } from "zod";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { client } from "@/lib/client";
import { learningAnalysisReason } from "@/lib/learning/display";
import { learningKeys } from "@/lib/learning/queries";

const path = "/api/copilotkit/admin/learning";
type Run = z.infer<typeof adminLearningHistory>["runs"][number];
type Decision = z.infer<typeof adminLearningDecision>["decision"];

const states: Record<Run["state"], string> = {
  running: "Analyzing",
  reconciling: "Checking model outcome",
  proposed: "Proposal generated",
  skipped: "Skipped",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function NativeLearningHistory() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const history = useQuery({
    queryKey: learningKeys.adminHistory,
    queryFn: async ({ signal }) =>
      adminLearningHistory.parse(
        await (
          await client(path, {
            signal,
            fallback: "Couldn't load analysis runs.",
          })
        ).json(),
      ),
    gcTime: 0,
    retry: false,
    refetchInterval: ({ state }) =>
      state.data?.runs.some(
        (run) => run.state === "running" || run.state === "reconciling",
      )
        ? 5000
        : false,
  });
  const runs = history.isError ? [] : (history.data?.runs ?? []);
  const proposal = runs.find((run) => run.id === selected)?.proposal;
  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: Decision }) =>
      client(`${path}/proposals/${encodeURIComponent(id)}`, {
        method: "POST",
        body: { decision },
        fallback: "Couldn't save the review.",
      }),
    onSuccess: async (_response, { decision }) => {
      setNotice(
        decision === "approve" ? "Proposal published." : "Proposal rejected.",
      );
      setSelected(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: learningKeys.directChat }),
        queryClient.invalidateQueries({
          queryKey: learningKeys.publishedSkills,
        }),
      ]);
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.adminHistory }),
  });
  return (
    <PageSection
      title="Analysis runs"
      description="See up to 50 recent runs you can review. Proposals include only evidence you currently have permission to read."
    >
      <VStack gap={3}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={history.isFetching}
          onClick={() => void history.refetch()}
        >
          Refresh runs
        </Button>
        {history.isPending && <p role="status">Loading analysis runs…</p>}
        {history.error && <p role="alert">{history.error.message}</p>}
        {notice && <p role="status">{notice}</p>}
        {review.error && !proposal && (
          <p role="alert">{review.error.message}</p>
        )}
        {history.isSuccess && runs.length === 0 && (
          <PageEmpty icon={IconHistory} title="No analysis runs available" />
        )}
        {runs.length > 0 && (
          <PageRows>
            {runs.map((run) => (
              <Item key={run.id} size="sm">
                <ItemContent>
                  <ItemTitle>
                    {run.proposal?.title ?? states[run.state]}
                  </ItemTitle>
                  <ItemDescription>
                    {run.proposal && `${states[run.state]} · `}
                    {new Date(run.startedAt).toLocaleString()} ·{" "}
                    {run.evidenceCount} evidence{" "}
                    {run.evidenceCount === 1 ? "item" : "items"}
                  </ItemDescription>
                  {learningAnalysisReason(run.reason) && (
                    <ItemDescription>
                      {learningAnalysisReason(run.reason)}
                    </ItemDescription>
                  )}
                  {run.proposal && (
                    <ItemDescription>
                      {run.proposal.decision === "approve"
                        ? "Published"
                        : run.proposal.decision === "reject"
                          ? "Rejected"
                          : "Pending review"}
                    </ItemDescription>
                  )}
                </ItemContent>
                {run.proposal && (
                  <ItemActions>
                    <Button
                      aria-label={`Review ${run.proposal.title}`}
                      disabled={history.isFetching || review.isPending}
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={async () => {
                        review.reset();
                        setNotice("");
                        const refreshed = await history.refetch();
                        if (
                          refreshed.data?.runs.some(
                            (current) =>
                              current.id === run.id && current.proposal,
                          )
                        ) {
                          setSelected(run.id);
                        } else if (refreshed.isSuccess) {
                          setNotice(
                            "This proposal is no longer available for review.",
                          );
                        }
                      }}
                    >
                      Review
                    </Button>
                  </ItemActions>
                )}
              </Item>
            ))}
          </PageRows>
        )}
      </VStack>
      <Dialog
        open={Boolean(proposal)}
        onOpenChange={(open) => {
          if (!open && !review.isPending) setSelected(null);
        }}
      >
        {proposal && selected && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{proposal.title}</DialogTitle>
              <DialogDescription>
                Approval publishes the skill for the original conversation and
                Bot.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <VStack gap={3}>
                <p className="whitespace-pre-wrap break-words">
                  {proposal.instructions}
                </p>
                <h3>Evidence</h3>
                <VStack as="ul" gap={2}>
                  {proposal.evidence.map((item) =>
                    "source" in item ? (
                      <li key={`${item.source.kind}:${item.source.id}`}>
                        <strong>{item.title}</strong>
                        <p className="whitespace-pre-wrap break-words">
                          {item.excerpt}
                        </p>
                      </li>
                    ) : (
                      <li key={item.runId}>
                        <p className="whitespace-pre-wrap break-words">
                          Person · {item.prompt}
                        </p>
                        <p className="whitespace-pre-wrap break-words">
                          Bot · {item.reply}
                        </p>
                      </li>
                    ),
                  )}
                </VStack>
                {review.error && <p role="alert">{review.error.message}</p>}
                {!proposal.decision && !proposal.canApprove && (
                  <p>Learning must be enabled to publish this proposal.</p>
                )}
              </VStack>
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={review.isPending}
                onClick={() => setSelected(null)}
              >
                Close
              </Button>
              {!proposal.decision && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={history.isFetching || review.isPending}
                    onClick={() =>
                      review.mutate({ id: selected, decision: "reject" })
                    }
                  >
                    Reject
                  </Button>
                  <Button
                    type="button"
                    disabled={
                      !proposal.canApprove ||
                      history.isFetching ||
                      review.isPending
                    }
                    onClick={() =>
                      review.mutate({ id: selected, decision: "approve" })
                    }
                  >
                    Approve and publish
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </PageSection>
  );
}
