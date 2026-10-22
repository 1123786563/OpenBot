import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

/**
 * The person's own async jobs read (Bifrost 17.8, #332) as the browser sees it, mirroring
 * `/api/billing/credits/async-jobs` exactly — the same shape the realtime sessions read
 * keeps.
 *
 * The account is never a parameter: the server resolves the payer from the session, so
 * this module sends no account identifier of any kind — the jobs it answers are the
 * signed-in reader's own, and only those (他人任务不可见 is the server's own rule; the
 * client cannot weaken it). Amounts are the ledger's own ×100 integers
 * (`maximumCents`/`settledCents`/`pendingCents`), scaled at render the way
 * `format.credits` expects, so the page's numbers and the ledger's cannot disagree. The
 * attribution each row carries is the job row's own frozen grant/payer — the server reads
 * those columns and never the key's live state, which is what "Key 到期后任务仍显示原归属
 * 账户" looks like from the browser: a revoked key changes nothing here.
 */

/** The job's status in the code table 17.1–17.7's implementation holds (17.8's 码表). */
export type AsyncJobStatus =
  | "queued"
  | "running"
  | "pending-settlement"
  | "settled"
  | "refused"
  | "cancelled";

/** One async job as the server's view answers it. */
export type AsyncJobUsage = {
  jobId: string;
  providerJobId: string | null;
  model: { provider: string; model: string; capability: string };
  createdAt: string;
  dispatchedAt: string | null;
  status: AsyncJobStatus;
  /** The displayable sentence behind a waiting state, when there is one. */
  statusReason: string | null;
  attribution: { grantId: string; payerKind: string; payerId: string };
  /** The cap the submit reserved, ×100 scaled. */
  maximumCents: number;
  /** The settled charge, ×100 scaled — 0 until the terminal settle lands. */
  settledCents: number;
  /** The amount awaiting settlement or disposal, ×100 scaled. */
  pendingCents: number;
};

export const asyncJobsKeys = {
  all: ["billing", "asyncJobs"] as const,
  list: [...(["billing", "asyncJobs"] as const), "list"] as const,
};

/** Reads the async jobs path; a 404 surface is the billing-unavailable fact. */
async function readJobs(
  fallback: string,
  selection: { tenantId: string; workspaceId: string } | null = null,
): Promise<{ jobs: AsyncJobUsage[] }> {
  const response = await tryClient("/api/billing/credits/async-jobs", {
    fallbackKey: "billing.scopedRead",
    ...(selection ?? {}),
  });
  if (response.status === 404) {
    throw new Error("Async jobs are unavailable on this deployment.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? fallback);
  }
  return (await response.json()) as { jobs: AsyncJobUsage[] };
}

/**
 * The person's own async jobs — status, reason and amounts. Always fresh, the same reason
 * the balance read is uncached: a running job's money can move with every settle.
 */
export const asyncJobsQueryOptions = queryOptions({
  queryKey: asyncJobsKeys.list,
  staleTime: 0,
  queryFn: async (): Promise<AsyncJobUsage[]> =>
    (await readJobs("Your async jobs could not be loaded.")).jobs,
});

/** The scoped half: the same read filed under the scope in force (MT097's contract). */
export function scopedAsyncJobsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  const open = scope.status === "open" ? scope : null;
  return queryOptions({
    enabled: open !== null,
    queryKey: open
      ? [...open.prefix, ...asyncJobsKeys.list]
      : [...asyncJobsKeys.list, ":scope-pending"],
    staleTime: 0,
    queryFn: async (): Promise<AsyncJobUsage[]> => {
      if (open === null) throw new Error("Billing data is not readable yet.");
      const answer = await guarded(queryClient, open.userId, () =>
        readJobs("Your async jobs could not be loaded.", open.selection),
      );
      return answer.jobs;
    },
  });
}
