import { decisionInvalidated } from "@openbot/shared/approval-outcomes";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { approvalRequests } from "../db/schema/approvals";
import { personalSaasAccounts } from "../db/schema/personal-saas";
import { workItems } from "../db/schema/work";
import { readExecutionAccess } from "./account-access";
import { PERSONAL_BOT_WORK } from "./bot-work";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Read here by what acts on a request; the sentence and the person's words for it are shared. */
export { decisionInvalidated };

export async function readDecisionAccess(
  tx: Transaction,
  owner: string,
  now: () => number,
  origin?: {
    runId: string;
    threadId?: string;
    createdAt?: Date;
    epoch?: number;
  },
) {
  if (!z.uuid().safeParse(owner).success) return null;
  const access = await readExecutionAccess(tx, owner, now);
  if (access?.kind !== "active" || !origin) return access;
  const [work] = await tx
    .select({
      epoch: workItems.accountEpoch,
      interruption: workItems.interruption,
    })
    .from(workItems)
    .where(
      and(
        origin.threadId && origin.threadId !== origin.runId
          ? or(
              eq(workItems.key, origin.runId),
              and(
                eq(workItems.kind, PERSONAL_BOT_WORK),
                eq(workItems.key, origin.threadId),
              ),
            )
          : eq(workItems.key, origin.runId),
        eq(workItems.accountId, owner),
      ),
    )
    .orderBy(sql`${workItems.kind} = ${PERSONAL_BOT_WORK} DESC`)
    .limit(1);
  if (work?.interruption?.reason === "user_stopped")
    return { kind: "denied" } as const;
  const epoch = origin.epoch ?? work?.epoch;
  if (epoch != null)
    return access.epoch === epoch ? access : ({ kind: "denied" } as const);
  if (origin.createdAt) {
    const createdAt = origin.createdAt.getTime();
    const [account] = await tx
      .select({ status: personalSaasAccounts.status })
      .from(personalSaasAccounts)
      .where(eq(personalSaasAccounts.id, owner));
    if (
      account?.status?.executionCutoffs?.some(
        ({ cutoffAt }) => createdAt <= cutoffAt,
      )
    )
      return { kind: "denied" } as const;
  }
  return access;
}

export async function reconcileDecisionHistory(
  tx: Transaction,
  owner: string,
  now: () => number,
) {
  const access = await readDecisionAccess(tx, owner, now);
  if (!access) return;
  const [account] = await tx
    .select({ status: personalSaasAccounts.status })
    .from(personalSaasAccounts)
    .where(eq(personalSaasAccounts.id, owner));
  const cutoffs = account?.status?.executionCutoffs ?? [];
  const latestCutoff = cutoffs.reduce(
    (latest, { cutoffAt }) => Math.max(latest, cutoffAt),
    0,
  );
  const stale = (
    epoch: ReturnType<typeof sql>,
    createdAt: typeof workItems.createdAt | typeof approvalRequests.createdAt,
  ) =>
    access.kind === "denied"
      ? sql`true`
      : or(
          sql`${epoch} <> ${access.epoch}`,
          and(
            sql`${epoch} is null`,
            sql`${createdAt} <= ${new Date(latestCutoff).toISOString()}::timestamptz`,
          ),
        );
  await tx
    .update(approvalRequests)
    .set({
      status: "completed",
      completedAt: sql`clock_timestamp()`,
      action: sql`${approvalRequests.action} || '{"executionInvalidated":true}'::jsonb`,
      result: sql`coalesce(${approvalRequests.result}, jsonb_build_object('content', ${decisionInvalidated}::text, 'error', ${decisionInvalidated}::text))`,
    })
    .where(
      and(
        eq(approvalRequests.ownerUserId, owner),
        ne(approvalRequests.status, "completed"),
        stale(
          sql`(${approvalRequests.action}->>'executionEpoch')::integer`,
          approvalRequests.createdAt,
        ),
      ),
    );
  await tx
    .update(workItems)
    .set({ finishedAt: sql`clock_timestamp()`, lastError: decisionInvalidated })
    .where(
      and(
        isNull(workItems.finishedAt),
        inArray(workItems.kind, [
          "approval.resume",
          "person.question",
          "person.response",
        ]),
        or(
          eq(workItems.accountId, owner),
          sql`${workItems.payload}->>'actorId' = ${owner}`,
          sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
        ),
        stale(sql`${workItems.accountEpoch}`, workItems.createdAt),
      ),
    );
}

/** Keep a claimed continuation under its original epoch even if the account recovers mid-turn. */
export async function runWithDecisionAccess<T>(
  database: Database,
  owner: string,
  origin: NonNullable<Parameters<typeof readDecisionAccess>[3]>,
  run: (execution: {
    signal?: AbortSignal;
    beforeDispatch?: () => Promise<void>;
  }) => Promise<T>,
  now = Date.now,
) {
  const read = () =>
    database.transaction((tx) => readDecisionAccess(tx, owner, now, origin));
  const initial = await read();
  if (!initial) return run({});
  const stopped = new Error(decisionInvalidated);
  if (initial.kind === "denied") throw stopped;
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expiresAt = initial.expiresAt;
  function scheduleExpiry() {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => abort.abort(stopped),
      Math.max(0, expiresAt - now()),
    );
  }
  const beforeDispatch = async () => {
    if (now() >= expiresAt) abort.abort(stopped);
    abort.signal.throwIfAborted();
    const access = await read();
    abort.signal.throwIfAborted();
    if (
      now() >= expiresAt ||
      access?.kind !== "active" ||
      access.epoch !== initial.epoch
    ) {
      abort.abort(stopped);
      abort.signal.throwIfAborted();
    }
    if (access?.kind === "active") {
      expiresAt = access.expiresAt;
      scheduleExpiry();
    }
  };
  scheduleExpiry();
  let checking = false;
  let finished = false;
  const poll = setInterval(() => {
    if (checking || finished) return;
    checking = true;
    void beforeDispatch()
      .catch(() => {
        // The existing deadline remains in force if the access lookup fails.
      })
      .finally(() => {
        checking = false;
      });
  }, 1_000);
  try {
    return await run({ signal: abort.signal, beforeDispatch });
  } finally {
    finished = true;
    clearInterval(poll);
    abort.abort(stopped);
    clearTimeout(deadline);
  }
}
