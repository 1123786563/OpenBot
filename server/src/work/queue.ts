/**
 * Claiming durable work, so several replicas can share it without a coordinator.
 *
 * `select ... for update skip locked` inside a transaction: each replica takes rows nobody else
 * holds and never waits behind another's. No leader election, no single point of failure, and a
 * replica added is throughput added rather than contention added.
 *
 * A claim carries a lease. While the work runs its owner renews; one that stops being renewed is
 * free again the moment anything looks, so recovery needs no process to notice a death, only the
 * next claim to read the clock.
 *
 * Lease and scheduling decisions use the database clock. Leases used to be
 * computed as `Date.now() + leaseMs` on the replica and compared against `now()` in Postgres, which
 * is two clocks pretending to be one: a node ninety seconds behind wrote a sixty-second lease that
 * Postgres considered expired on arrival, and the next replica to look took the item straight out
 * from under the first. Both then ran it.
 */
import {
  and,
  eq,
  gte,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import postgres from "postgres";
import type { Database } from "../db/client";
import {
  deliveryOutbox,
  personalSaasAccounts,
  personalWorkspaces,
  proactiveSettings,
  responsibilities,
  responsibilityRuns,
  workItems,
} from "../db/schema";
import { readExecutionAccess } from "../personal-saas/account-access";
import { workspaceResourceOwner } from "../personal-saas/workspace-principal";
import { currentWorkGrant } from "./execution";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type WorkRow = typeof workItems.$inferSelect;
// These payloads are produced by server-side writers, never by a client.
function unattendedPrincipal(
  tx: Transaction,
  kind: string,
  payload: Record<string, unknown>,
  key: string,
) {
  switch (kind) {
    case "group.turn":
    case "bot.wakeup":
      return typeof payload.ownerUserId === "string"
        ? payload.ownerUserId
        : undefined;
    case "delivery.outbound":
      return typeof payload.ownerUserId === "string"
        ? payload.ownerUserId
        : tx
            .select({ owner: deliveryOutbox.ownerUserId })
            .from(deliveryOutbox)
            .where(eq(deliveryOutbox.id, key));
    case "bot.message":
      return typeof payload.actorId === "string" ? payload.actorId : undefined;
    case "proactive.run":
      return typeof payload.ownerUserId === "string"
        ? payload.ownerUserId
        : tx
            .select({ owner: proactiveSettings.ownerUserId })
            .from(proactiveSettings)
            .where(eq(proactiveSettings.id, String(payload.settingId)));
    case "responsibility.run":
      return typeof payload.ownerUserId === "string"
        ? payload.ownerUserId
        : tx
            .select({ owner: responsibilities.ownerUserId })
            .from(responsibilityRuns)
            .innerJoin(
              responsibilities,
              eq(responsibilities.id, responsibilityRuns.responsibilityId),
            )
            .where(eq(responsibilityRuns.id, String(payload.runId)));
  }
}

export const unattendedWorkLabels = {
  "group.turn": "Group run",
  "bot.wakeup": "Bot follow-up",
  "bot.message": "Bot handoff",
  "proactive.run": "Check-in",
  "responsibility.run": "Responsibility",
  "delivery.outbound": "Background notification",
};

const unattendedKinds = new Set(Object.keys(unattendedWorkLabels));

async function unattendedAccount(
  tx: Transaction,
  kind: string,
  payload: Record<string, unknown>,
  key: string,
) {
  const source = unattendedPrincipal(tx, kind, payload, key);
  const principal =
    typeof source === "string" ? source : (await source)?.[0]?.owner;
  if (!principal) return;
  const prefix = workspaceResourceOwner("");
  if (principal.startsWith(prefix)) {
    const [workspace] = await tx
      .select({ ownerId: personalWorkspaces.ownerId })
      .from(personalWorkspaces)
      .where(
        sql`${personalWorkspaces.id}::text = ${principal.slice(prefix.length)}`,
      );
    // A workspace principal never becomes a local user when its workspace disappears.
    return workspace?.ownerId ?? null;
  }
  const [account] = await tx
    .select({ id: personalSaasAccounts.id })
    .from(personalSaasAccounts)
    .where(sql`${personalSaasAccounts.id}::text = ${principal}`);
  return account?.id;
}

type Interruption = NonNullable<WorkRow["interruption"]>;
type HeldWork = { kind: string; key: string; owner: string };

/**
 * Said aloud when work is queued, so a sweep can start now instead of at its next poll.
 *
 * The payload is the kind, and nothing more: a listener decides whether it sweeps that kind at
 * all, and the queue stays the truth either way. A notification is a latency optimisation, never
 * a delivery mechanism — one lost in transit costs up to one poll interval, not the work.
 */
export const WORK_OFFERED_TOPIC = "openbot_work_offered";

/** Inside the offering transaction where there is one, so it fires on commit and never before. */
const announceOffered = (db: Pick<Database, "execute">, kind: string) =>
  db.execute(sql`select pg_notify(${WORK_OFFERED_TOPIC}, ${kind})`);

export type WorkOfferedListener = { stop: () => Promise<void> };

/**
 * Hear work being offered, from any instance, including this one.
 *
 * On its own connection, because `LISTEN` holds one for the life of the subscription: taken from
 * the pool, it would be a connection the rest of the server never gets back.
 */
export async function startWorkOfferedListener(
  databaseUrl: string,
  onOffered: (kind: string) => void,
): Promise<WorkOfferedListener> {
  const connection = postgres(databaseUrl, { max: 1 });

  await connection.listen(WORK_OFFERED_TOPIC, (payload) => {
    try {
      onOffered(payload);
    } catch {
      // A listener's mistake is not a reason to tear down the subscription: the poll behind it is
      // still correct, and the next sweep picks up whatever this wake-up would have.
    }
  });

  return {
    stop: async () => {
      await connection.end();
    },
  };
}

export type WorkItem = {
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  /**
   * How many times this has been handed out, including now.
   *
   * ONE MEANS IT HAS CERTAINLY NOT RUN. More than one means a previous owner stopped renewing, and
   * may already have called a tool or spent money before it did. A caller that cannot tell those
   * apart cannot safely retry anything with an outside effect, so this is a number rather than a
   * state folded into failure.
   */
  attempts: number;
  authorization?: {
    accountId: string;
    epoch: number;
    expiresAt: number;
    authorizedAt: number;
  };
};

/**
 * How many times one item may be handed out before it stops being offered.
 *
 * Without a cap a permanently failing item is retried until somebody notices, which on a queue with
 * no dashboard is never. At the cap it stops being claimed and stays in the table with its count and
 * its last error, which is a terminal state a person can query rather than a silence.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

export type WorkQueue = {
  /**
   * Put work on the queue, or leave what is there. Idempotent on (kind, key).
   *
   * `"queued"` is new work. `"already"` is the same key again — the caller asked for this work to be
   * queued and it is, but it is NOT a second piece of work, and a caller that reports it as one is
   * announcing something that will not happen. `"refused"` is `atMost` saying no.
   *
   * Three answers rather than a boolean because two of them used to be true: a hop offered under a
   * key that already existed was reported to the model as handed over, while the row it named had
   * long since been delivered and finished. Nothing was queued and nobody was ever going to run it.
   */
  offer: (item: {
    kind: string;
    key: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
    accountId?: string;
    expectedEpoch?: number;
    authorizedSince?: number;
    /**
     * Refuse this if the prefix is already that full.
     *
     * COUNTED AND WRITTEN AS ONE STEP, which is the whole reason it lives here rather than in the
     * caller. Counting first and offering second is a cap that holds only while nothing else is
     * offering: a model that emits five tool calls in one turn runs all five at once, each reads a
     * count taken before any of the others had written, and all five pass a cap of three. The
     * failure needs no cluster and no unusual timing; it is what asking for several things at once
     * looks like.
     */
    atMost?: { keyPrefix: string; max: number };
  }) => Promise<"queued" | "already" | "refused">;
  /** Take up to `limit` due items, leased to `owner`. */
  claim: (input: {
    kind: string;
    owner: string;
    leaseMs: number;
    limit?: number;
    maxAttempts?: number;
    ready?: SQL;
  }) => Promise<WorkItem[]>;
  executionExpiry?: (input: HeldWork) => Promise<number | undefined>;
  /** Keep a claim alive while the work runs. False means it was already taken away. */
  renew: (input: {
    kind: string;
    key: string;
    owner: string;
    leaseMs: number;
  }) => Promise<boolean>;
  /**
   * Done. False means the lease had already gone to somebody else, so this was not ours to finish.
   */
  finish: (input: {
    kind: string;
    key: string;
    owner: string;
  }) => Promise<boolean>;
  /** Not done, and worth another go after `delayMs`. False means it was no longer ours. */
  release: (input: {
    kind: string;
    key: string;
    owner: string;
    delayMs: number;
    reason?: string;
    /**
     * This hand-out was not an attempt: the work was certainly not started, because something it
     * waits on was not ready (a conversation somebody else is running in). The claim's count is
     * given back, so waiting never spends the attempts that exist for real failures, and the next
     * claim still says, truthfully, that the work has not run.
     */
    uncounted?: boolean;
    /** Fields written over the payload's, for what the work keeps between tries. */
    payload?: Record<string, unknown>;
  }) => Promise<boolean>;
  /**
   * Drop what is done with, older than the retention window. Returns how many went.
   *
   * Both kinds of done: finished, and given up on. An item at its attempt cap is not finished and was
   * reaped by nothing, so its key stayed occupied for ever and the work could never be offered again.
   *
   * TWO KINDS OF DONE, TWO WINDOWS. They are the same length only by coincidence. A finished row is
   * kept so a late offer of the same key collides with it, which needs to outlast a sweep; a row that
   * gave up is kept because the window is also the backoff before anything tries again, which wants
   * to be long. Kept as one number, a queue whose work repeats has to choose which of those to be
   * wrong about. `finishedOlderThanMs` defaults to `olderThanMs`, so a caller that has only one
   * answer keeps the behaviour it had.
   */
  purge: (input: {
    kind: string;
    olderThanMs: number;
    finishedOlderThanMs?: number;
    maxAttempts?: number;
  }) => Promise<number>;
};

/**
 * A literal prefix, safe to put in a `like`.
 *
 * `%` and `_` are wildcards there, and a key is allowed to contain both. Without this a run whose id
 * held an underscore would count rows belonging to other runs, and a fan-out cap that counts the
 * wrong rows is a cap that refuses the wrong hops.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** A moment `ms` from now, named in SQL so it is the database's clock and not the caller's. */
function fromNow(ms: number) {
  return sql`now() + make_interval(secs => ${ms / 1000})`;
}

export function parkedPersonalWork(kind: string, key: SQL) {
  return sql`exists (select 1 from work_items as origin
    where origin.kind = ${kind} and origin.key = ${key}
      and origin.account_id = ${workItems.accountId}
      and origin.run_at = ${parkedUntil}
      and origin.finished_at is null and origin.interruption is null)`;
}

// A decision owns the next dispatch while its originating Bot work remains recoverable.
const parkedUntil = sql`'9999-01-01'::timestamptz`;

export function createWorkQueue(
  database: Database | Transaction,
  now = Date.now,
  options?: { personalOnly: true },
) {
  const keyed = (kind: string, key: string) =>
    and(eq(workItems.kind, kind), eq(workItems.key, key));
  const unfinished = and(
    isNull(workItems.finishedAt),
    isNull(workItems.interruption),
  );
  const heldBy = ({ kind, key, owner }: HeldWork) =>
    and(keyed(kind, key), eq(workItems.claimedBy, owner));

  async function stop(
    tx: Transaction,
    row: WorkRow,
    cause: Pick<Interruption, "reason" | "cutoffAt">,
  ) {
    await tx
      .update(workItems)
      .set({
        interruption: sql`${JSON.stringify({
          ...cause,
          recordedAt: now(),
        })}::text::jsonb || jsonb_build_object('outcomeUnknown', ${workItems.attempts} > 0)`,
        leaseUntil: null,
        updatedAt: sql`now()`,
      })
      .where(and(keyed(row.kind, row.key), unfinished));
  }

  async function authorize(tx: Transaction, row: WorkRow, skipLocked = false) {
    if (row.accountId === null || row.accountEpoch === null) return;
    const access = await readExecutionAccess(
      tx,
      row.accountId,
      now,
      row.accountEpoch,
      skipLocked,
    );
    if (access?.kind === "denied")
      await stop(tx, row, {
        reason: access.reason,
        cutoffAt: access.cutoffAt,
      });
    return access;
  }

  async function underClaim<T>(
    input: HeldWork,
    operation: (tx: Transaction, expiresAt?: number) => Promise<T>,
  ) {
    return database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workItems)
        .where(and(heldBy(input), unfinished));
      if (!row) return;
      if (row.accountId !== null) {
        // Locks are acquired account first here and on recovery. Claim uses SKIP LOCKED
        // when it needs the account lock after locking a queue row.
        const access = await authorize(tx, row);
        if (access?.kind !== "active") return;
        return operation(tx, access.expiresAt);
      }
      return operation(tx);
    });
  }

  /**
   * Still ours, and still wanting doing.
   *
   * `finish` and `release` used to match on the key alone, so a replica whose lease had quietly
   * expired could delete or reschedule an item another replica was in the middle of executing. Only
   * `renew` got this right; all three ask the same question now.
   */
  const ours = (kind: string, key: string, owner: string) =>
    and(
      eq(workItems.kind, kind),
      eq(workItems.key, key),
      eq(workItems.claimedBy, owner),
      unfinished,
      or(
        isNull(workItems.accountId),
        sql`${workItems.leaseUntil} > clock_timestamp()`,
      ),
    );

  const queue: WorkQueue = {
    async offer({
      kind,
      key,
      payload = {},
      runAt,
      atMost,
      accountId,
      expectedEpoch,
      authorizedSince,
    }) {
      const write = async (
        transaction: Pick<Database, "insert">,
        accountEpoch?: number,
        boundAccountId?: string,
      ) =>
        transaction
          .insert(workItems)
          .values({
            kind,
            key,
            payload,
            accountId: boundAccountId,
            accountEpoch,
            ...(runAt ? { runAt } : {}),
          })
          /*
           * Nothing on conflict, deliberately.
           *
           * The key is the identity of the work, so a second offer of the same thing is the same
           * thing, not a new one. For a routine the key carries the minute it was due, which is what
           * makes "three replicas woke at 07:00" produce one run instead of three. A finished row
           * still counts as a conflict, which is what makes that true after the run as well as during
           * it.
           */
          .onConflictDoNothing()
          // Returning the key, so a caller can tell work it just queued from work that was already
          // there. Nothing is written on conflict, so this comes back empty for a duplicate.
          .returning({ key: workItems.key });

      if (!atMost && !accountId && !unattendedKinds.has(kind)) {
        const [written] = await write(database);
        if (written) await announceOffered(database, kind);
        return written ? "queued" : "already";
      }

      return database.transaction(async (transaction) => {
        const boundAccountId =
          accountId ??
          (await unattendedAccount(transaction, kind, payload, key));
        if (boundAccountId === null) return "refused";
        const parent = currentWorkGrant();
        if (parent?.accountId === boundAccountId && parent?.signal.aborted)
          return "refused";
        const access = boundAccountId
          ? await readExecutionAccess(
              transaction,
              boundAccountId,
              now,
              parent?.accountId === boundAccountId
                ? (parent?.epoch ?? expectedEpoch)
                : expectedEpoch,
            )
          : undefined;
        if (boundAccountId && access?.kind !== "active") return "refused";
        if (boundAccountId && authorizedSince !== undefined) {
          const [account] = await transaction
            .select({ status: personalSaasAccounts.status })
            .from(personalSaasAccounts)
            .where(eq(personalSaasAccounts.id, boundAccountId));
          if (
            account?.status?.executionCutoffs?.some(
              (event) => event.cutoffAt >= authorizedSince,
            )
          )
            return "refused";
        }
        const epoch = access?.kind === "active" ? access.epoch : undefined;
        if (!atMost) {
          const [written] = await write(transaction, epoch, boundAccountId);
          if (written) await announceOffered(transaction, kind);
          return written ? "queued" : "already";
        }
        /*
         * Everything offered under this prefix, one at a time, across every replica.
         *
         * An advisory lock rather than a stricter isolation level, because the thing being counted
         * is rows another transaction has not committed yet: under `read committed` two concurrent
         * offers each see a count taken before the other wrote, and both pass. The lock is held for
         * the transaction and taken on the prefix, so it serialises one run's own hops and nothing
         * else on the queue waits behind them.
         */
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${kind}:${atMost.keyPrefix}`}))`,
        );
        const [row] = await transaction
          .select({ total: sql<number>`count(*)::int` })
          .from(workItems)
          .where(
            and(
              eq(workItems.kind, kind),
              like(workItems.key, `${escapeLike(atMost.keyPrefix)}%`),
            ),
          );
        /*
         * The same key again is not a new one. Counted as already there rather than refused, or a
         * retried offer of work that is on the queue would report the cap as the reason it is not.
         */
        const already = await transaction
          .select({ key: workItems.key })
          .from(workItems)
          .where(and(eq(workItems.kind, kind), eq(workItems.key, key)))
          .limit(1);
        if (already.length > 0) return "already";
        if ((row?.total ?? 0) >= atMost.max) return "refused";
        const [written] = await write(transaction, epoch, boundAccountId);
        if (written) await announceOffered(transaction, kind);
        return written ? "queued" : "already";
      });
    },

    async claim({
      kind,
      owner,
      leaseMs,
      limit = 1,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
      ready,
    }) {
      return database.transaction(async (transaction) => {
        /*
         * `skip locked` is what makes this concurrent rather than merely correct. Without it a
         * second replica blocks on the first replica's rows and the queue serialises; with it, it
         * walks past them and takes the next free ones.
         */
        const due = await transaction
          .select()
          .from(workItems)
          .where(
            and(
              eq(workItems.kind, kind),
              options?.personalOnly
                ? isNotNull(workItems.accountId)
                : undefined,
              ready,
              unfinished,
              or(
                lt(workItems.attempts, maxAttempts),
                isNotNull(workItems.accountId),
              ),
              lte(workItems.runAt, sql`now()`),
              or(
                isNull(workItems.leaseUntil),
                lte(workItems.leaseUntil, sql`now()`),
              ),
            ),
          )
          .orderBy(workItems.runAt)
          .limit(limit)
          .for("update", { skipLocked: true });

        const claimed: WorkItem[] = [];
        for (const stored of due) {
          if (stored.accountId === null && unattendedKinds.has(kind)) {
            const accountId = await unattendedAccount(
              transaction,
              kind,
              stored.payload,
              stored.key,
            );
            if (accountId === null) {
              await stop(transaction, stored, {
                reason: "account_status_unconfirmed",
                cutoffAt: null,
              });
              continue;
            }
            if (accountId) {
              const [bound] = await transaction
                .update(workItems)
                .set({ accountId })
                .where(keyed(stored.kind, stored.key))
                .returning();
              if (bound)
                await stop(transaction, bound, {
                  reason: "account_status_unconfirmed",
                  cutoffAt: null,
                });
              continue;
            }
          }
          const access = await authorize(transaction, stored, true);
          if (stored.accountId !== null && access?.kind !== "active") continue;
          if (stored.accountId !== null && stored.attempts > 0) {
            await stop(transaction, stored, {
              reason: "worker_lost",
              cutoffAt: null,
            });
            continue;
          }
          const [updated] = await transaction
            .update(workItems)
            .set({
              claimedBy: owner,
              leaseUntil: fromNow(leaseMs),
              attempts: sql`${workItems.attempts} + 1`,
              updatedAt: sql`now()`,
            })
            .where(keyed(stored.kind, stored.key))
            .returning({
              kind: workItems.kind,
              key: workItems.key,
              payload: workItems.payload,
              attempts: workItems.attempts,
            });
          if (updated) {
            claimed.push({
              kind: updated.kind,
              key: updated.key,
              payload: updated.payload,
              attempts: updated.attempts,
              ...(stored.accountId !== null &&
                access?.kind === "active" && {
                  authorization: {
                    accountId: stored.accountId,
                    epoch: access.epoch,
                    expiresAt: access.expiresAt,
                    authorizedAt: stored.createdAt.getTime(),
                  },
                }),
            });
          }
        }
        return claimed;
      });
    },

    executionExpiry(input) {
      return underClaim(input, async (tx, expiresAt) => {
        const [held] = await tx
          .select({ key: workItems.key })
          .from(workItems)
          .where(ours(input.kind, input.key, input.owner));
        return held ? expiresAt : undefined;
      });
    },

    async renew({ kind, key, owner, leaseMs }) {
      const [renewed] =
        (await underClaim({ kind, key, owner }, (tx) =>
          tx
            .update(workItems)
            .set({ leaseUntil: fromNow(leaseMs), updatedAt: sql`now()` })
            /*
             * Only while still ours. A lease that expired and was taken by somebody else must not be
             * renewed back out from under them, which would put two replicas on one item believing they
             * each held it.
             */
            .where(ours(kind, key, owner))
            .returning({ key: workItems.key }),
        )) ?? [];
      return Boolean(renewed);
    },

    async finish({ kind, key, owner }) {
      const [finished] =
        (await underClaim({ kind, key, owner }, (tx) =>
          tx
            .update(workItems)
            /*
             * Marked, not deleted. The row is what a later offer of the same key collides with, and
             * deleting it handed that key back to anybody who re-offered it: the recovery path was also
             * a duplicate-run path. Swept later by `purge`.
             */
            .set({
              finishedAt: sql`now()`,
              claimedBy: null,
              leaseUntil: null,
              updatedAt: sql`now()`,
            })
            .where(ours(kind, key, owner))
            .returning({ key: workItems.key }),
        )) ?? [];
      return Boolean(finished);
    },

    async release({ kind, key, owner, delayMs, reason, uncounted, payload }) {
      // Freed and pushed out, rather than finished: the work still wants doing, just not immediately
      // and not by whoever just gave up on it. The reason stays on the row so an item that runs out
      // of attempts says why rather than simply stopping.
      const [released] =
        (await underClaim({ kind, key, owner }, (tx) =>
          tx
            .update(workItems)
            .set({
              claimedBy: null,
              leaseUntil: null,
              runAt: fromNow(delayMs),
              updatedAt: sql`now()`,
              ...(reason === undefined ? {} : { lastError: reason }),
              ...(uncounted
                ? { attempts: sql`greatest(${workItems.attempts} - 1, 0)` }
                : {}),
              ...(payload === undefined
                ? {}
                : {
                    // Sent as text and parsed here: a parameter typed jsonb is encoded again by the
                    // driver, and `||` with a JSON string makes the payload an array.
                    payload: sql`${workItems.payload} || ${JSON.stringify(payload)}::text::jsonb`,
                  }),
            })
            .where(ours(kind, key, owner))
            .returning({ key: workItems.key }),
        )) ?? [];
      return Boolean(released);
    },

    async purge({
      kind,
      olderThanMs,
      finishedOlderThanMs = olderThanMs,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
    }) {
      const cutoff = fromNow(-olderThanMs);
      const finishedCutoff = fromNow(-finishedOlderThanMs);
      const gone = await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, kind),
            isNull(workItems.accountId),
            or(
              lt(workItems.finishedAt, finishedCutoff),
              /*
               * AND THE ONES THAT GAVE UP, which is the half this forgot.
               *
               * An item at its attempt cap is not finished, so it was reaped by nothing: `claim`
               * skipped it, `purge` did not match it, and `offer` cannot replace a row that is still
               * there. Its key was wedged for good. The culler keys on the Bot id, so five failed
               * suspends meant that Bot never scaled to zero again, silently and for ever.
               *
               * Reaped on the same window rather than kept, because the window is also how long it
               * waits before anything tries again: whatever was broken has had a day to be fixed,
               * and the next sweep offers the work afresh. The audit trail is where "this failed"
               * lives; this table is what still wants doing.
               */
              and(
                gte(workItems.attempts, maxAttempts),
                lt(workItems.updatedAt, cutoff),
              ),
            ),
          ),
        )
        .returning({ key: workItems.key });
      return gone.length;
    },
  };

  function forAccount(kind: string, accountId: string) {
    return and(eq(workItems.kind, kind), eq(workItems.accountId, accountId));
  }

  return {
    ...queue,
    async park(input: HeldWork) {
      const [parked] =
        (await underClaim(input, (tx) =>
          tx
            .update(workItems)
            .set({ runAt: parkedUntil, claimedBy: null, leaseUntil: null })
            .where(ours(input.kind, input.key, input.owner))
            .returning({ key: workItems.key }),
        )) ?? [];
      return Boolean(parked);
    },
    async settleParked(
      kind: string,
      account: string,
      key: string,
      outcome: { kind: "complete"; output: string } | { kind: "interrupted" },
    ) {
      return database.transaction(async (tx) => {
        const where = and(
          keyed(kind, key),
          eq(workItems.accountId, account),
          unfinished,
          sql`${workItems.runAt} = ${parkedUntil}`,
        );
        const [row] = await tx.select().from(workItems).where(where);
        if (!row || (await authorize(tx, row))?.kind !== "active") return;
        if (outcome.kind === "interrupted") {
          await stop(tx, row, { reason: "run_interrupted", cutoffAt: null });
          return;
        }
        await tx
          .update(workItems)
          .set({ finishedAt: sql`now()`, output: outcome.output })
          .where(where);
      });
    },
    async reconcilePersonalWork(kind: string, accountId?: string) {
      const rows = await database
        .select()
        .from(workItems)
        .where(
          and(
            unfinished,
            eq(workItems.kind, kind),
            accountId === undefined
              ? isNotNull(workItems.accountId)
              : eq(workItems.accountId, accountId),
          ),
        );
      for (const row of rows) {
        await database.transaction(async (tx) => {
          const access = await authorize(tx, row);
          if (access?.kind !== "active" || row.attempts === 0) return;
          const [locked] = await tx
            .select()
            .from(workItems)
            .where(
              and(
                keyed(row.kind, row.key),
                unfinished,
                lte(workItems.leaseUntil, sql`clock_timestamp()`),
              ),
            )
            .for("update");
          if (locked)
            await stop(tx, locked, { reason: "worker_lost", cutoffAt: null });
        });
      }
    },
    async personalStatus(kind: string, accountId: string, key: string) {
      const [row] = await database
        .select({
          finishedAt: workItems.finishedAt,
          interruption: workItems.interruption,
          recovery: workItems.recovery,
          output: workItems.output,
          attempts: workItems.attempts,
          parked: sql<boolean>`${workItems.runAt} = ${parkedUntil}`,
        })
        .from(workItems)
        .where(and(forAccount(kind, accountId), keyed(kind, key)));
      if (!row) return;
      const { attempts, parked, ...result } = row;
      const state = row.interruption
        ? "stopped"
        : row.finishedAt
          ? "completed"
          : parked
            ? "waiting"
            : attempts
              ? "running"
              : "queued";
      return { ...result, state };
    },
    async interrupted(kind: string, accountId: string) {
      return database
        .select({
          key: workItems.key,
          payload: workItems.payload,
          output: workItems.output,
          interruption: workItems.interruption,
          recovery: workItems.recovery,
        })
        .from(workItems)
        .where(
          and(forAccount(kind, accountId), isNotNull(workItems.interruption)),
        )
        .orderBy(workItems.createdAt);
    },
    async interruptedKind(accountId: string, key: string) {
      const rows = await database
        .select({ kind: workItems.kind })
        .from(workItems)
        .where(
          and(
            eq(workItems.accountId, accountId),
            eq(workItems.key, key),
            isNotNull(workItems.interruption),
          ),
        )
        .limit(2);
      return rows.length === 1 ? rows[0]?.kind : undefined;
    },
    async recover(input: {
      kind: string;
      accountId: string;
      key: string;
      action: "cancel" | "retry";
      acknowledged: boolean;
      mayRetry?: (
        tx: Transaction,
        payload: WorkRow["payload"],
      ) => Promise<boolean>;
      startFresh?: (
        tx: Transaction,
        payload: WorkRow["payload"],
      ) => Promise<string | undefined>;
    }) {
      const { kind, accountId, key, action } = input;
      return database.transaction(async (tx) => {
        const access = await readExecutionAccess(tx, accountId, now);
        if (access?.kind !== "active") return { kind: "forbidden" } as const;
        const [row] = await tx
          .select()
          .from(workItems)
          .where(
            and(
              forAccount(kind, accountId),
              keyed(kind, key),
              isNotNull(workItems.interruption),
            ),
          )
          .for("update");
        if (!row?.interruption) return { kind: "missing" } as const;
        if (row.recovery)
          return { kind: "resolved", recovery: row.recovery } as const;
        if (
          action === "retry" &&
          row.interruption.outcomeUnknown &&
          !input.acknowledged
        )
          return { kind: "acknowledgement_required" } as const;
        if (
          action === "retry" &&
          input.mayRetry &&
          !(await input.mayRetry(tx, row.payload))
        )
          return { kind: "forbidden" } as const;
        if (now() >= access.expiresAt) return { kind: "forbidden" } as const;

        let recovery: NonNullable<WorkRow["recovery"]> = { action: "cancel" };
        if (action === "retry") {
          if (input.startFresh) {
            const newKey = await input.startFresh(tx, row.payload);
            if (!newKey) return { kind: "forbidden" } as const;
            recovery = { action, key: newKey };
          } else {
            if (!input.mayRetry) return { kind: "forbidden" } as const;
            const newKey = crypto.randomUUID();
            const offered = await createWorkQueue(tx, now).offer({
              kind,
              key: newKey,
              payload: row.payload,
              accountId,
            });
            if (offered !== "queued") return { kind: "forbidden" } as const;
            recovery = { action, key: newKey };
          }
        }
        await tx
          .update(workItems)
          .set({ recovery, updatedAt: sql`now()` })
          .where(keyed(kind, key));
        return { kind: "resolved", recovery } as const;
      });
    },
    async checkpoint(input: HeldWork, output: string) {
      await database
        .update(workItems)
        .set({ output })
        .where(
          and(
            heldBy(input),
            isNotNull(workItems.accountId),
            isNull(workItems.finishedAt),
          ),
        );
    },
    async endInterrupted(
      input: HeldWork,
      endedAt: number | undefined,
      localCutoffAt?: number,
      computerBlocked = false,
    ) {
      await database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(workItems)
          .where(
            and(
              heldBy(input),
              isNotNull(workItems.accountId),
              isNull(workItems.finishedAt),
            ),
          );
        if (!row) return;
        await authorize(tx, row);
        await tx
          .update(workItems)
          .set({
            interruption: sql`coalesce(${workItems.interruption}, ${JSON.stringify(
              {
                reason:
                  localCutoffAt === undefined
                    ? computerBlocked
                      ? "computer_unavailable"
                      : "run_interrupted"
                    : "account_status_unconfirmed",
                cutoffAt: localCutoffAt ?? null,
                outcomeUnknown: !computerBlocked,
                recordedAt: now(),
              },
            )}::text::jsonb) || jsonb_strip_nulls(jsonb_build_object('endedAt', ${endedAt ?? null}::bigint))`,
            claimedBy: null,
            leaseUntil: null,
          })
          .where(and(heldBy(input), isNull(workItems.finishedAt)));
      });
    },
  };
}
