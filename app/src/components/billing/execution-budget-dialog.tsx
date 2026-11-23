import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { microcreditsFromCredits } from "@/lib/billing/mutations";
import {
  billingKeys,
  billingQuoteQueryOptions,
  resumePointsQueryOptions,
} from "@/lib/billing/queries";
import { client } from "@/lib/client";

export function ExecutionBudgetDialog({
  title,
  onClose,
  submit,
  operationId,
}: {
  title: string;
  onClose: () => void;
  submit: (budgetId?: string) => Promise<unknown>;
  operationId?: string;
}) {
  const queries = useQueryClient();
  const points = useQuery({
    ...resumePointsQueryOptions(),
    enabled: !!operationId,
  });
  const point = points.data?.find((entry) => entry.operationId === operationId);
  const paidContinuation = point?.reason === "trial_ended";
  const chooseBudget = !operationId || !!(point && !point.confirmedAt);
  const quote = useQuery({
    ...billingQuoteQueryOptions(),
    enabled: chooseBudget,
  });
  const [choice, setChoice] = useState<"test" | "paid">("test");
  const creditType = paidContinuation ? "paid" : choice;
  const [limit, setLimit] = useState("");
  const max = limit.length <= 19 ? microcreditsFromCredits(limit) : undefined;
  const currentQuote = quote.data;
  const review = useMutation({
    mutationFn: async () => {
      if (!chooseBudget) return submit();
      if (!currentQuote || !max)
        throw new Error("Review the quote and enter a spending cap.");
      const budgetId = crypto.randomUUID();
      await client("/api/billing/budgets", {
        method: "POST",
        body: {
          budgetId,
          creditType,
          limitMicrocredits: max,
          modelQuote: {
            route: currentQuote.route,
            priceVersion: currentQuote.priceVersion,
          },
        },
        fallback:
          "Could not confirm the execution budget. Review the current quote and try again.",
      });
      if (operationId)
        await client(
          `/api/billing/resume-points/${encodeURIComponent(operationId)}/confirm`,
          {
            method: "POST",
            body: { budgetId },
            fallback: "Could not confirm this step's continuation.",
          },
        );
      return submit(budgetId);
    },
    onSuccess: async () => {
      onClose();
      await queries.invalidateQueries({ queryKey: billingKeys.all });
    },
    onError: () => queries.invalidateQueries({ queryKey: billingKeys.all }),
  });

  const checking = operationId && points.isPending;
  const fetchError =
    operationId && points.error
      ? points.error
      : chooseBudget
        ? quote.error
        : null;
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !review.isPending) onClose();
      }}
      purpose="form"
    >
      <VStack gap={3}>
        <DialogHeader title={title} />
        {checking ? <p role="status">Checking this step…</p> : null}
        {chooseBudget ? (
          <>
            <p>
              Credits currently cover text replies. This run has no connected
              apps or Bot tools.
            </p>
            {quote.isPending ? (
              <p role="status">Loading the verified quote…</p>
            ) : null}
            {currentQuote ? (
              <p>
                {currentQuote.model} costs {currentQuote.price.inputPerMillion}{" "}
                microcredits per million input tokens and{" "}
                {currentQuote.price.outputPerMillion} microcredits per million
                output tokens. A single request can reserve up to{" "}
                {currentQuote.maxChargeMicrocredits} microcredits. Interrupted,
                cancelled, or failed requests can still use Credits.
              </p>
            ) : null}
            {paidContinuation ? (
              <p>
                The trial has ended. Confirm a new Paid Credit budget to
                continue.
              </p>
            ) : (
              <SegmentedControl
                label="Credit type"
                value={choice}
                onChange={(value) =>
                  setChoice(value === "paid" ? "paid" : "test")
                }
                isDisabled={review.isPending}
              >
                <SegmentedControlItem value="test" label="Test Credits" />
                <SegmentedControlItem value="paid" label="Paid Credits" />
              </SegmentedControl>
            )}
            <TextInput
              label="Cumulative cap in Credits"
              value={limit}
              onChange={setLimit}
              inputMode="decimal"
              isDisabled={review.isPending}
            />
            {point ? (
              <p>
                The new cap includes charges already incurred by this execution.
              </p>
            ) : null}
          </>
        ) : !checking && !fetchError ? (
          <p>
            {point?.confirmedAt
              ? `Continue with the confirmed ${point.creditType === "paid" ? "Paid" : "Test"} Credit budget.`
              : "OpenBot will check the existing operation. Work can continue when its billing outcome is known."}
          </p>
        ) : null}
        {fetchError ? <p role="alert">{fetchError.message}</p> : null}
        {review.error ? <p role="alert">{review.error.message}</p> : null}
        <HStack justify="end" gap={2} wrap="wrap">
          <Button
            label="Cancel"
            onClick={onClose}
            isDisabled={review.isPending}
          />
          <Button
            label={
              review.isPending
                ? "Confirming…"
                : chooseBudget
                  ? paidContinuation
                    ? "Confirm Paid Credits and continue"
                    : "Confirm and continue"
                  : "Recheck and continue"
            }
            variant="primary"
            isDisabled={
              !!(
                checking ||
                fetchError ||
                review.isPending ||
                (chooseBudget && (!currentQuote || !max || max.length > 18))
              )
            }
            onClick={() => review.mutate()}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
}

export function ContinueBudgetedWork({
  operationId,
  path,
  queryKey,
}: {
  operationId: string;
  path: string;
  queryKey: readonly unknown[];
}) {
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button label="Continue" size="sm" onClick={() => setOpen(true)} />
      {open ? (
        <ExecutionBudgetDialog
          title="Continue this work"
          operationId={operationId}
          onClose={() => setOpen(false)}
          submit={async () => {
            await client(path, {
              method: "POST",
              fallback: "Could not continue this work.",
            });
            await queries.invalidateQueries({ queryKey });
          }}
        />
      ) : null}
    </>
  );
}
