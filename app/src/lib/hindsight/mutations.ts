/**
 * The person's Hindsight memory writes (#387/#389/#390, FR-4): the three review decisions on a
 * judgment candidate, the text-only re-assertion of an adopted judgment, the correction and
 * forgetting launched from an expanded basis, and the explicit cleanup verification.
 *
 * Like the reads beside them, none of these carries a company or team selection: the server
 * resolves one trusted scope per request, and a body that tried to name a tenant, principal or
 * bank is not refused — it is simply never read. Every success settles the whole `hindsight`
 * namespace, because each write changes what the next answer (and the next expansion) reads.
 */

import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  hindsightKeys,
  type MemoryRevocation,
  type ReviewedJudgment,
} from "./queries";

/** One settlement for every write here: re-read whatever the seams now answer. */
const settle = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: hindsightKeys.all });

/** Adopt a candidate (#389): the gates re-ran on the server; the answer is the adopted judgment. */
export const confirmJudgmentMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string): Promise<ReviewedJudgment> =>
      client(
        `/api/hindsight/judgments/${encodeURIComponent(id)}/confirm`,
        "judgment",
        {
          method: "POST",
          fallbackKey: "hindsight.confirm",
        },
      ),
    onSettled: settle(queryClient),
  });

/**
 * Re-assert a judgment's text (#389 AC2): the words alone change — the evidence relation and
 * scope never ride this call, so an edit can neither swap the basis nor widen the authority.
 */
export const editJudgmentMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { content: string };
    }): Promise<ReviewedJudgment> =>
      client(`/api/hindsight/judgments/${encodeURIComponent(id)}`, "judgment", {
        method: "PATCH",
        body: input,
        fallbackKey: "hindsight.edit",
      }),
    onSettled: settle(queryClient),
  });

/** Reject a candidate (#389): terminal on the server; the settle drops it from the listing. */
export const rejectJudgmentMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string): Promise<unknown> =>
      client(
        `/api/hindsight/judgments/${encodeURIComponent(id)}/reject`,
        "judgment",
        {
          method: "POST",
          fallbackKey: "hindsight.reject",
        },
      ),
    onSettled: settle(queryClient),
  });

/**
 * Forget a judgment (#390 AC3): the answer is the honest two-part status — stopped using it at
 * `stoppedUsingAt`, remote cleanup reported separately and never claimed cleared. The screen
 * shows exactly that and points at the cleanup section for the rest.
 */
export const forgetJudgmentMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: async (id: string): Promise<MemoryRevocation> =>
      (
        await client(`/api/hindsight/judgments/${encodeURIComponent(id)}`, {
          method: "DELETE",
          fallbackKey: "hindsight.forget",
        })
      ).json(),
    onSettled: settle(queryClient),
  });

/**
 * Correct a preference basis from the evidence entry (#387 AC2): the new fact supersedes the
 * old window, and the next answer reads the corrected row. Only a preference basis offers this
 * action; the seam refuses the other kinds with its own reason.
 */
export const correctEvidenceMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, input }: { id: string; input: { content: string } }) =>
      client(`/api/hindsight/evidence/${encodeURIComponent(id)}/correction`, {
        method: "POST",
        body: input,
        fallbackKey: "hindsight.correct",
      }),
    onSettled: settle(queryClient),
  });

/** Forget a preference basis (#387 AC2 / #390): same honest answer as a judgment forget. */
export const forgetPreferenceEvidenceMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: async (id: string): Promise<MemoryRevocation> =>
      (
        await client(
          `/api/memory/hindsight/preferences/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            fallbackKey: "hindsight.forget",
          },
        )
      ).json(),
    onSettled: settle(queryClient),
  });

/** Forget a source-bound basis (#387 AC2 / #390), through the memory family's own face. */
export const forgetSourceBoundEvidenceMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: async (id: string): Promise<MemoryRevocation> =>
      (
        await client(
          `/api/memory/hindsight/source-bound/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            fallbackKey: "hindsight.forget",
          },
        )
      ).json(),
    onSettled: settle(queryClient),
  });

/**
 * Re-probe the person's own confirmed deletions and reconcile the backup manifests (#391): the
 * actions behind the cleanup picture. Idempotent, and the settle re-reads what it observed.
 */
export const verifyCleanupMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: () =>
      client("/api/hindsight/cleanup/verify", {
        method: "POST",
        fallbackKey: "hindsight.verify",
      }),
    onSettled: settle(queryClient),
  });
