/**
 * The person's Hindsight memory writes (#387/#389/#390, FR-4): the three review decisions on a
 * judgment candidate, the text-only re-assertion of an adopted judgment, the correction and
 * forgetting launched from an expanded basis, and the explicit cleanup verification.
 *
 * Every write rides the scope the screen holds (MT089's family, FIX-W12 FR2-1): the selection
 * pair rides the request, the server's membership decides, and a body that tried to name a
 * tenant, principal or bank is not refused — it is simply never read. Each success settles the
 * scope's own `hindsight` subtree, because each write changes what the next answer (and the
 * next expansion, and the adopted listing) reads.
 */

import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { memoryKeys } from "@/lib/memory";
import {
  hindsightKeys,
  type MemoryRevocation,
  type ReviewedJudgment,
} from "./queries";

/** The selection pair a scoped call rides, spread into the client options (MT089's family). */
function scopePair(scope: ScopedCache) {
  return scope.status === "open" ? (scope.selection ?? {}) : {};
}

/**
 * One settlement for every write here: re-read whatever the seams now answer, under the scope
 * the write rode. A switch that happened mid-flight already removed that prefix, so the
 * invalidation lands as the no-op it should be rather than resurrecting anything.
 */
const settle = (queryClient: QueryClient, scope: ScopedCache) => () =>
  scope.status === "open"
    ? queryClient.invalidateQueries({
        queryKey: [...scope.prefix, ...hindsightKeys.all],
      })
    : undefined;

/**
 * The wider settlement a preference or source-bound basis write earns: those writes ride the
 * memory family's own Hindsight face (`/api/memory/hindsight/*`), and the settings page shows
 * the memory rows — whose sync badges this chain answers — beside the answer-basis listing.
 * A row corrected or forgotten from an expansion must not survive as-is on that side of the
 * page until a reload, so both subtrees settle under the scope the write rode.
 */
const settleBothFaces =
  (queryClient: QueryClient, scope: ScopedCache) => () => {
    if (scope.status !== "open") return;
    queryClient.invalidateQueries({
      queryKey: [...scope.prefix, ...hindsightKeys.all],
    });
    queryClient.invalidateQueries({
      queryKey: [...scope.prefix, ...memoryKeys.all],
    });
  };

/**
 * Adopt a candidate (#389): the gates re-ran on the server; the answer is the adopted
 * judgment. `confirmSensitive` is the F-G1-4 second look: the server refuses
 * medical/financial/customer text without it, and the retry that carries it is the one the
 * judgment review's refusal notice offers (O3-M4).
 */
export const confirmJudgmentMutationOptions = (
  queryClient: QueryClient,
  scope: ScopedCache,
) =>
  mutationOptions({
    mutationFn: ({
      id,
      confirmSensitive,
    }: {
      id: string;
      confirmSensitive?: boolean;
    }): Promise<ReviewedJudgment> =>
      client(
        `/api/hindsight/judgments/${encodeURIComponent(id)}/confirm`,
        "judgment",
        {
          method: "POST",
          ...(confirmSensitive === undefined
            ? {}
            : { body: { confirmSensitive } }),
          fallbackKey: "hindsight.confirm",
          ...scopePair(scope),
        },
      ),
    onSettled: settle(queryClient, scope),
  });

/**
 * Re-assert a judgment's text (#389 AC2): the words alone change — the evidence relation and
 * scope never ride this call, so an edit can neither swap the basis nor widen the authority.
 */
export const editJudgmentMutationOptions = (
  queryClient: QueryClient,
  scope: ScopedCache,
) =>
  mutationOptions({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      /** The re-asserted text; `confirmSensitive` is the F-G1-4 second look (O3-M4). */
      input: { content: string; confirmSensitive?: boolean };
    }): Promise<ReviewedJudgment> =>
      client(`/api/hindsight/judgments/${encodeURIComponent(id)}`, "judgment", {
        method: "PATCH",
        body: input,
        fallbackKey: "hindsight.edit",
        ...scopePair(scope),
      }),
    onSettled: settle(queryClient, scope),
  });

/** Reject a candidate (#389): terminal on the server; the settle drops it from the listing. */
export const rejectJudgmentMutationOptions = (
  queryClient: QueryClient,
  scope: ScopedCache,
) =>
  mutationOptions({
    mutationFn: (id: string): Promise<unknown> =>
      client(
        `/api/hindsight/judgments/${encodeURIComponent(id)}/reject`,
        "judgment",
        {
          method: "POST",
          fallbackKey: "hindsight.reject",
          ...scopePair(scope),
        },
      ),
    onSettled: settle(queryClient, scope),
  });

/**
 * Forget a judgment (#390 AC3): the answer is the honest two-part status — stopped using it at
 * `stoppedUsingAt`, remote cleanup reported separately and never claimed cleared. The screen
 * shows exactly that and points at the cleanup section for the rest.
 */
export const forgetJudgmentMutationOptions = (
  queryClient: QueryClient,
  scope: ScopedCache,
) =>
  mutationOptions({
    mutationFn: async (id: string): Promise<MemoryRevocation> =>
      (
        await client(`/api/hindsight/judgments/${encodeURIComponent(id)}`, {
          method: "DELETE",
          fallbackKey: "hindsight.forget",
          ...scopePair(scope),
        })
      ).json(),
    onSettled: settle(queryClient, scope),
  });

/**
 * Correct a preference basis from the evidence entry (#387 AC2): the new fact supersedes the
 * old window, and the next answer reads the corrected row. Only a preference basis offers this
 * action; the seam refuses the other kinds with its own reason.
 */
export const correctEvidenceMutationOptions = (
  queryClient: QueryClient,
  scope: ScopedCache,
) =>
  mutationOptions({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      /** The corrected text; `confirmSensitive` is the F-G1-4 second look (O3-M4). */
      input: { content: string; confirmSensitive?: boolean };
    }): Promise<void> => {
      await client(
        `/api/hindsight/evidence/${encodeURIComponent(id)}/correction`,
        {
          method: "POST",
          body: input,
          fallbackKey: "hindsight.correct",
          ...scopePair(scope),
        },
      );
    },
    onSettled: settleBothFaces(queryClient, scope),
  });

/** Forget a preference basis (#387 AC2 / #390): same honest answer as a judgment forget. */
export const forgetPreferenceEvidenceMutationOptions = (
  queryClient: QueryClient,
  scope: ScopedCache,
) =>
  mutationOptions({
    mutationFn: async (id: string): Promise<MemoryRevocation> =>
      (
        await client(
          `/api/memory/hindsight/preferences/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            fallbackKey: "hindsight.forget",
            ...scopePair(scope),
          },
        )
      ).json(),
    onSettled: settleBothFaces(queryClient, scope),
  });

/** Forget a source-bound basis (#387 AC2 / #390), through the memory family's own face. */
export const forgetSourceBoundEvidenceMutationOptions = (
  queryClient: QueryClient,
  scope: ScopedCache,
) =>
  mutationOptions({
    mutationFn: async (id: string): Promise<MemoryRevocation> =>
      (
        await client(
          `/api/memory/hindsight/source-bound/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            fallbackKey: "hindsight.forget",
            ...scopePair(scope),
          },
        )
      ).json(),
    onSettled: settleBothFaces(queryClient, scope),
  });

/**
 * Re-probe the person's own confirmed deletions and reconcile the backup manifests (#391): the
 * actions behind the cleanup picture. Idempotent, and the settle re-reads what it observed.
 */
export const verifyCleanupMutationOptions = (
  queryClient: QueryClient,
  scope: ScopedCache,
) =>
  mutationOptions({
    mutationFn: () =>
      client("/api/hindsight/cleanup/verify", {
        method: "POST",
        fallbackKey: "hindsight.verify",
        ...scopePair(scope),
      }),
    onSettled: settle(queryClient, scope),
  });
