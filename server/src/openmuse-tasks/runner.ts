/**
 * Executing one queued OpenMuse Task (contracts §7 "small first path"): the row
 * T01 created is offered to the shared WorkQueue; this claims it once, runs ONE
 * headless private-Bot turn through the same turn runner a follow-up uses, and
 * settles the row `succeeded`/`failed` within a configurable deadline. The
 * client may close the moment the POST returns — nothing about the run hangs
 * off the request.
 *
 * MIRRORS agents/wake-up.ts `createWakeUpRunner` deliberately: the same queue
 * and its database-clock lease (no second lease system), and the same `runTurn`
 * seam, wired in index.ts to the same `createTurnRunner` a follow-up's turn is.
 *
 * T07 (issue #64): a lease lost BEFORE any external effect is recovered — one
 * re-run as a new attempt, guarded by a CAS on the row's `attempts` so a stale
 * sweep cannot finish the new owner's claim. A lease lost AFTER a possible
 * external effect, or a turn that ends ambiguously, is never replayed: the row
 * lands `failed` with a reconciliation-wait detail and the ambiguity on the
 * evidence. maxAttempts 2 on the claim is the exactly-once: one fresh attempt,
 * one recovery, never a third.
 *
 * T08 (issue #65): a turn the injected `inputWaitOf` classifier flags parks
 * the row `waiting_input` with a §7 wait record; the owner's answer consumes
 * it once and re-offers the row. The classifier seam exists because no runTurn
 * producer can express a wait yet — C07/T15's document flow is its owner.
 *
 * T09 (issue #66): a plan Task's steps carry its graph. One sweep runs ONE
 * ready step — every predecessor succeeded, itself not — through the same
 * runTurn seam with the step's title as the instruction, then requeues the
 * row for the next sweep. Succeeded steps are never replayed (readiness is a
 * status check on the durable row); a failure stops the plan until an
 * explicit retry resets what did not complete.
 *
 * T10 (issue #67): a monitor Task checks on its schedule, not on arrival.
 * Creation offers the row with runAt = nextCheckAt (the queue's delayed
 * items — the scheduling decision, work/queue.ts offer/claim), so a sweep
 * claims a monitor exactly when it is due; one due check runs through the
 * injectable checkMonitor seam and records its raw observation as evidence,
 * then re-arms nextCheckAt = now + interval and the row returns to
 * `scheduled`. Cancel and pause prevent later offers by skipping the claimed
 * row without re-offering it.
 *
 * T11 (issue #68): observation identity and failure backoff. Identity is
 * sha256(monitorId + normalizedSource + normalizedValue); the cursor is the
 * last committed observation's hash and time on the row, so the SAME
 * observation emits one item even across restarts — an equal hash appends no
 * evidence row and raises no match signal — while a new one commits one row
 * carrying its match verdict (T12's notification seam). A failed check backs
 * off 15/30/60 minutes doubling, capped at six hours; any completed check
 * resets the streak and re-arms the interval.
 */

import { createHash } from "node:crypto";
import type { PDFDocument } from "pdf-lib";
import { getLogger } from "../../../shared/logger";
import type { AgentActor } from "../agents/profile-types";
import type { AuditInitiator } from "../audit";
import type { AgentChannel } from "../channels/routes";
import {
  applyFill,
  createPdfFillAdapter,
  type PdfFillAdapter,
  validateFill,
} from "../openmuse-documents/fill";
import {
  createPdfFieldExtractor,
  extractPdfDocument,
  inspectPdfDocument,
  loadPdfDocument,
  type PdfFieldExtractor,
} from "../openmuse-documents/inspect";
import type { OpenMuseFileStore } from "../openmuse-files/store";
import { AMOUNT_CONVENTION, analyzeSpending } from "../openmuse-finance/csv";
import type { OpenMuseNotificationEvent } from "../openmuse-notifications/store";
import type { DocumentReplyReview } from "../openmuse-reviewed-actions/service";
import type { WorkQueue } from "../work/queue";
import {
  OPENMUSE_TASK_MAX_ATTEMPTS,
  type TaskWorkerCapacity,
  taskWorkerCapacity,
} from "./capacity";
import type {
  OpenMuseEvidence,
  OpenMuseMonitorCondition,
  OpenMuseTaskStep,
  OpenMuseTaskStore,
  OpenMuseWaitField,
  StoredOpenMuseTask,
} from "./store";
import { documentTaskInput, OPENMUSE_TASK_KIND, reviewWaitOf } from "./store";

export { OPENMUSE_TASK_KIND } from "./store";

const log = getLogger("server");

/**
 * T12: the §7 notification emit seam — what the runner calls on a landed
 * transition. T16 (review waits) is `task.waiting_review`'s first producer —
 * the review park emits it — so every enumerated kind now has its owner here.
 */
export type OpenMuseNotificationEmit = (event: {
  userId: string;
  taskId: string;
  eventKind: OpenMuseNotificationEvent;
  attemptKey: string;
  title: string;
  detail?: string;
}) => Promise<unknown>;

/**
 * F-TASK-2's seam: a turn whose failure leaves its outside effects unknowable.
 * The turn runner does not throw this yet (live-gate wiring to come); when it
 * does, this is the shape — recognised duck-typed by name, cross-realm safe.
 */
export class AmbiguousTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousTurnError";
  }
}

const isAmbiguousTurn = (error: unknown) =>
  error instanceof AmbiguousTurnError ||
  (error instanceof Error && error.name === "AmbiguousTurnError");

/** The §7 reconciliation-wait detail: names the ambiguity, promises no replay. */
const RECONCILIATION_DETAIL =
  "Lease lost with possible external effects: outcome ambiguous, not retried, awaiting reconciliation.";

/**
 * The §7 one-step acceptance deadline, default 300 seconds: a Task that has
 * not finished within it is failed with the timeout as the cause, never
 * claimed a success. Override per deployment with OPENMUSE_TASK_DEADLINE_MS.
 */
export const TASK_DEADLINE_MS = (() => {
  const raw = Number(process.env.OPENMUSE_TASK_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
})();

/** Headroom past the deadline for the settle writes, so the lease outlives the turn. */
const LEASE_HEADROOM_MS = 60_000;

/** How much of a failure's reason the row carries; the audit trail keeps the rest. */
const DETAIL_MAX = 500;

/** How much of the Bot's reply the result evidence excerpt carries; the step keeps it all. */
const EXCERPT_MAX = 2_000;

/**
 * T11: how many evidence rows one monitor keeps. A change monitor on a
 * drifting source commits a new observation row per check — as often as
 * once a minute — and every settle rewrites the whole jsonb column, so the
 * monitor's settles keep only the latest rows, pruned oldest-first.
 */
export const MONITOR_EVIDENCE_CAP = 50;

/**
 * T06×T07: whether a retained evidence/step row belongs to the CURRENT
 * attempts generation. The retry CAS stamps the rows it retains with the
 * generation that wrote them, so a recovery's prior-effect check reads
 * prior attempts' rows as history — their outcome is already recorded, not
 * an unknown external effect — and counts only rows the current generation
 * could have written. An absent stamp is treated as current: rows written
 * before the stamp existed stay conservative rather than recoverable.
 */
const ofCurrentAttempt = (
  row: { attempt?: number },
  attempt: number,
): boolean => row.attempt === undefined || row.attempt === attempt;

/** The turn the runner drives — the same seam a follow-up's turn runs through. */
export type OpenMuseTaskTurn = (input: {
  ownerUserId: string;
  routineId: string;
  agentId: string;
  threadId: string;
  instruction: string;
  initiator?: AuditInitiator;
  signal?: AbortSignal;
}) => Promise<{ replyText: string }>;

/**
 * T08's wait-for-input seam: what a turn's result says when it needs the
 * owner's answer before the Task can finish. The current `runTurn` seam
 * returns only `{replyText}` — no producer can express a wait yet — so the
 * default classifier never fires and the pipeline is proven with injected
 * doubles. The real producer lands with C07/T15's document flow and is
 * wired here; nothing is faked in the meantime.
 */
export type InputWaitClassifier = (turn: {
  replyText: string;
}) => { question: string; fields?: OpenMuseWaitField[] } | null;

/**
 * T10's monitor check seam: one due check of a scheduled monitor, returning
 * its raw observation. No producer is wired in index.ts yet (the integration
 * step owns the real source reads), so the default refuses rather than fakes
 * an observation — a check that cannot run is an error the runner records,
 * never a made-up value.
 */
export type MonitorCheck = (task: StoredOpenMuseTask) => Promise<{
  observation: string;
}>;

/**
 * T11: the §7 observation normal form — the two components identity is
 * hashed over. Source: the condition's watched source, trimmed, lowercased,
 * with trailing slashes collapsed, so URL casing/slash variants are one
 * identity. Value, canonical per kind: `change` keeps the raw text trimmed;
 * `contains` reduces to the bool of the match (its needle is the condition's
 * selector — no selector can never match); `price_below` reads the first
 * decimal number in the raw text as a fixed two-decimal string, and a text
 * with no readable price is an error the check records, never a made-up
 * value.
 */
export function normalizeObservation(
  condition: OpenMuseMonitorCondition,
  raw: string,
): { source: string; value: string } {
  const source = (condition.source ?? "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
  switch (condition.type) {
    case "change":
      return { source, value: raw.trim() };
    case "contains":
      return {
        source,
        value:
          condition.selector !== undefined && raw.includes(condition.selector)
            ? "true"
            : "false",
      };
    case "price_below": {
      /*
       * Strip thousands separators before the scan: "1,000.50" (or
       * "US$1,299.99") would otherwise truncate at the comma and read as
       * 1.00, flipping the threshold verdict. Only comma-followed-by-three-
       * digits-and-a-boundary goes; a European "1,23" decimal stays for the
       * number scan to mis-handle as it always has (recorded limit).
       */
      const found = raw.replace(/,(?=\d{3}\b)/g, "").match(/-?\d+(?:\.\d+)?/);
      if (found === null)
        throw new Error("The observation carries no readable price.");
      return { source, value: Number(found[0]).toFixed(2) };
    }
  }
}

/**
 * T11: the §7 observation identity — sha256(monitorId + normalizedSource +
 * normalizedValue), the three joined by newlines so no component can bleed
 * into its neighbour. The exact recipe is contract: fixture vectors pin it.
 */
export function observationHash(
  monitorId: string,
  normalizedSource: string,
  normalizedValue: string,
): string {
  return createHash("sha256")
    .update(`${monitorId}\n${normalizedSource}\n${normalizedValue}`)
    .digest("hex");
}

/**
 * T11: the §7 failure backoff — the delay after the n-th consecutive failed
 * check: 15, 30, 60 minutes doubling, capped at six hours.
 */
export function backoffMinutes(consecutiveFailures: number): number {
  return Math.min(15 * 2 ** Math.max(0, consecutiveFailures - 1), 6 * 60);
}

/**
 * T11: whether a committed observation satisfies its condition — the match
 * verdict on the check's evidence row, T12's notification seam. A change
 * monitor's first observation is the baseline a later change is measured
 * against, not itself a match.
 */
function monitorMatched(
  condition: OpenMuseMonitorCondition,
  normalizedValue: string,
  seen: { repeated: boolean; hadCursor: boolean },
): boolean {
  switch (condition.type) {
    case "change":
      return !seen.repeated && seen.hadCursor;
    case "contains":
      return normalizedValue === "true";
    case "price_below":
      return (
        condition.threshold !== undefined &&
        Number(normalizedValue) < condition.threshold
      );
  }
}

/**
 * T09: the next plan step a sweep may run — every predecessor succeeded and
 * the step itself has not. A failed step counts as runnable because the only
 * queued row that can hold one is the new attempt a T06 retry re-offered
 * (its CAS resets failed steps to pending; this is the belt to that braces).
 */
export function nextPlanStep(
  steps: OpenMuseTaskStep[],
): OpenMuseTaskStep | null {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return (
    steps.find(
      (step) =>
        (step.status === "pending" || step.status === "failed") &&
        step.dependsOn.every((id) => byId.get(id)?.status === "succeeded"),
    ) ?? null
  );
}

/**
 * T09: the step objects for a plan write — one step replaced (status, and
 * result/evidenceIds when the write settles it), the graph otherwise whole.
 */
export function withPlanStep(
  steps: OpenMuseTaskStep[],
  id: string,
  status: OpenMuseTaskStep["status"],
  result?: string,
  evidenceIds?: string[],
): OpenMuseTaskStep[] {
  return steps.map((step) =>
    step.id === id
      ? {
          ...step,
          status,
          ...(result !== undefined ? { result } : {}),
          ...(evidenceIds !== undefined ? { evidenceIds } : {}),
        }
      : step,
  );
}

export function createOpenMuseTaskRunner(options: {
  queue: Pick<WorkQueue, "claim" | "finish" | "purge" | "offer">;
  store: OpenMuseTaskStore;
  owner: string;
  actorFor: (ownerUserId: string) => Promise<AgentActor>;
  channels: {
    direct(actor: AgentActor, agentId: string): Promise<AgentChannel>;
  };
  runTurn: OpenMuseTaskTurn;
  /** The lease offered with each claim; defaults to the deadline plus settle headroom. */
  leaseMs?: number;
  /** The §7 deadline for one turn; tests inject a short one. */
  deadlineMs?: number;
  /** T08: classifies a finished turn as a wait; absent means no producer yet. */
  inputWaitOf?: InputWaitClassifier;
  /** T10: one due monitor check; absent means no producer is wired yet. */
  checkMonitor?: MonitorCheck;
  /**
   * T13: the openmuse-files seam a finance Task reads its CSV through and
   * uploads its summary artifact to; T15: the seam a document Task reads its
   * bound PDF through and appends its one derived version to. Absent means
   * no producer is wired yet (index.ts wiring is the integration step's), so
   * the default refuses rather than fakes — a run that cannot read its file
   * is an error the row records, never a made-up value.
   */
  files?: Pick<OpenMuseFileStore, "upload" | "getOwnedFile" | "appendVersion">;
  /** T15: the PDF inspection seam (F05); absent defaults to pdf-lib. */
  extract?: PdfFieldExtractor;
  /** T15: the PDF fill seam (F06); absent defaults to pdf-lib. */
  fill?: PdfFillAdapter;
  /**
   * T16: the reviewed-reply seam — openmuse-reviewed-actions' proposal
   * creation and status poll for a document Task's post-fill reply (compose
   * with `createDocumentReplyReview`). Absent means no producer is wired yet
   * (index.ts wiring is the integration step's), so the default refuses
   * rather than fakes — a reply that cannot be proposed is an error the row
   * records, never a made-up send.
   */
  review?: DocumentReplyReview;
  /**
   * T12: the §7 notification emit seam. The runner is the owning transition,
   * so it emits — never polling. Absent (a deployment without the
   * notifications store, or a test not asserting them) is a no-op, and an
   * emit that throws never fails the transition.
   */
  emitNotification?: OpenMuseNotificationEmit;
  /**
   * T10: the clock a monitor's nextCheckAt re-arms from after each check —
   * the database's in production, injected in tests. Monotonicity is all
   * that matters: the queue's due gate, not this clock, decides when a
   * check actually runs.
   */
  now?: () => Date;
  /**
   * O04 (§10 row 4): the per-process worker cap the sweep's claim limit
   * derives from. Defaults to OPENMUSE_TASK_WORKERS, default 4.
   */
  capacity?: TaskWorkerCapacity;
}) {
  const deadlineMs = options.deadlineMs ?? TASK_DEADLINE_MS;
  const leaseMs = options.leaseMs ?? deadlineMs + LEASE_HEADROOM_MS;
  const inputWaitOf: InputWaitClassifier = options.inputWaitOf ?? (() => null);
  const checkMonitor: MonitorCheck =
    options.checkMonitor ??
    (async () => {
      throw new Error("No monitor check producer is wired yet.");
    });
  const files: Pick<
    OpenMuseFileStore,
    "upload" | "getOwnedFile" | "appendVersion"
  > = options.files ?? {
    getOwnedFile: async () => {
      throw new Error("No finance or document file seam is wired yet.");
    },
    upload: async () => {
      throw new Error("No finance file seam is wired yet.");
    },
    appendVersion: async () => {
      throw new Error("No document file seam is wired yet.");
    },
  };
  const defaultPdfExtract = createPdfFieldExtractor();
  const extract: PdfFieldExtractor = options.extract ?? defaultPdfExtract;
  const fillAdapter: PdfFillAdapter = options.fill ?? createPdfFillAdapter();
  const review: DocumentReplyReview = options.review ?? {
    propose: async () => {
      throw new Error("No reviewed-reply seam is wired yet.");
    },
    resolve: async () => {
      throw new Error("No reviewed-reply seam is wired yet.");
    },
  };
  const emitNotification: OpenMuseNotificationEmit =
    options.emitNotification ?? (async () => {});
  const now = options.now ?? (() => new Date());
  const capacity = options.capacity ?? taskWorkerCapacity();
  const {
    queue: injectedQueue,
    store,
    owner,
    actorFor,
    channels,
    runTurn,
  } = options;
  /*
   * O04: every offer the runner makes is the executed Task continuing
   * ITSELF — a plan's next step, a monitor's re-armed check, a review poll —
   * so the sweep's claim loop drains INDEPENDENT due work (up to the free
   * slots) and stops the moment a Task re-offered its own continuation:
   * that work belongs to the sweep that finds it due, exactly as the
   * one-step-per-sweep contract has always read.
   */
  let selfReoffered = false;
  const queue: Pick<WorkQueue, "claim" | "finish" | "purge" | "offer"> = {
    ...injectedQueue,
    offer: async (item) => {
      selfReoffered = true;
      return injectedQueue.offer(item);
    },
  };
  /**
   * A landed transition's continuation offer (a plan's next step, a
   * monitor's re-armed check): best-effort BY DESIGN, but never silent.
   * The settle it follows has already committed, so throwing from here
   * would unwind into the per-item catch and re-settle a transition that
   * landed — a plan step that succeeded would be marked failed. Instead
   * the failure is logged loudly: the row is stranded (queued/scheduled
   * with no queue item, and no reconciliation scan exists to re-find it),
   * and that signal is what the log exists to carry until one does.
   */
  const offerContinuation = async (
    task: { id: string; ownerUserId: string },
    runAt?: Date,
  ): Promise<void> => {
    try {
      await queue.offer({
        kind: OPENMUSE_TASK_KIND,
        key: `${task.id}:${crypto.randomUUID()}`,
        payload: { ownerUserId: task.ownerUserId, taskId: task.id },
        ...(runAt ? { runAt } : {}),
      });
    } catch (error) {
      log.error(
        {
          type: "openmuse-task-reoffer-failed",
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "openmuse-task-reoffer-failed",
      );
    }
  };
  /**
   * T12: one §7 notification after a landed transition — best-effort, never
   * the transition's failure: the row is the record, the notification a
   * consequence of it. T16's review park is `task.waiting_review`'s producer.
   */
  const notify = async (
    landed: boolean,
    task: { ownerUserId: string; id: string },
    eventKind: OpenMuseNotificationEvent,
    attemptKey: string,
    title: string,
    detail?: string,
  ) => {
    if (!landed) return;
    try {
      await emitNotification({
        userId: task.ownerUserId,
        taskId: task.id,
        eventKind,
        attemptKey,
        title,
        ...(detail !== undefined ? { detail } : {}),
      });
    } catch (error) {
      // Logged and swallowed: an unreachable notification store must not
      // unwind a transition that already landed on the row.
      log.error(
        {
          type: "openmuse-notification-emit-failed",
          taskId: task.id,
          eventKind,
          error: error instanceof Error ? error.message : String(error),
        },
        "openmuse-notification-emit-failed",
      );
    }
  };

  /**
   * One claim round: claim a free slot's worth (always one item — the loop
   * below runs its claims inline, so a claim is made only when its execution
   * is next and its lease spans its own run), begin the slot, and execute
   * the claims. Returns how many worker slots it began — 0 when it claimed
   * nothing. The slot is released by the sweep wrapper at the END of the
   * whole sweep, so this process holds no more concurrent Task workers than
   * it has slots across its in-flight sweep rounds.
   */
  const sweepOnce = async (report: {
    ran: string[];
    skipped: string[];
  }): Promise<number> => {
    const limit = capacity.claimLimit();
    const claimed =
      limit === 0
        ? []
        : await queue.claim({
            kind: OPENMUSE_TASK_KIND,
            owner,
            leaseMs,
            limit,
            // T07: one fresh attempt plus exactly one recovery; never a third.
            maxAttempts: OPENMUSE_TASK_MAX_ATTEMPTS,
          });
    // The begin() return is honoured: if the cap filled between claimLimit()
    // and here, this round runs unslotted but never decrements a slot it
    // does not hold.
    const holdsSlot = claimed.length > 0 && capacity.begin();
    for (const item of claimed) {
      const finish = () =>
        queue.finish({ kind: OPENMUSE_TASK_KIND, key: item.key, owner });
      try {
        // T05: a resume re-offers under a fresh key with the task id in the
        // payload; create's own offer still keys on the id itself.
        const payload = item.payload as {
          ownerUserId?: string;
          taskId?: string;
        };
        const task = payload?.ownerUserId
          ? await store.get(payload.ownerUserId, payload.taskId ?? item.key)
          : null;
        /*
         * D02 (§9): a deleted owner's work is never run. The fence stops
         * new requests, the bulk shutdown cancelled the rows — this check
         * is the backstop for anything a claim already handed over (a
         * monitor's due offer, a lease-expired T07 recovery re-offer):
         * finish-with-skip, no check, no turn, no re-offer, the row left
         * exactly as the claim found it.
         */
        if (task && (await store.ownerDisabled(task.ownerUserId))) {
          await finish();
          report.skipped.push(item.key);
          continue;
        }
        const detail = (error: unknown) =>
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            DETAIL_MAX,
          );
        /*
         * The lease-recovery prologue (round 6 M42): the ~40-line block that
         * was copied near-verbatim across the monitor, finance, document and
         * generic branches — four copies that had already begun drifting, and
         * whose lockstep is exactly-once (T07) itself. A running row with
         * prior attempts either already acted (fails with the reconciliation
         * detail — never replays blind) or is provably effect-free (re-runs
         * as a new generation, attempts+1 in a CAS); a row in the kind's own
         * entry status is claimed running under the read's status CAS.
         * Answers the generation to run, or null when the claim is done
         * (already finished, skipped, and reported).
         *
         * The generic branch keeps its own variant on purpose: its
         * priorEffect also reads steps, and its ambiguous settle writes them
         * (T09's plan graph) — genuinely different policy, not drift.
         */
        const recoverLease = async (
          claimed: Pick<
            StoredOpenMuseTask,
            "id" | "ownerUserId" | "status" | "attempts" | "evidence"
          >,
          options: {
            /** The status a fresh claim accepts (monitor: scheduled; the rest: queued). */
            entryStatus: "scheduled" | "queued";
            /** Whether the current generation already acted — true fails, never replays. */
            priorEffect: boolean;
            /** The ambiguous settle's evidence excerpt and notification detail. */
            ambiguousExcerpt: string;
            ambiguousDetail: string;
          },
        ): Promise<number | null> => {
          if (claimed.status === "running" && item.attempts > 1) {
            if (options.priorEffect) {
              const failed = await store.settleTask(claimed.id, {
                ifAttempts: claimed.attempts,
                status: "failed",
                appendedEvidence: [
                  {
                    id: `${claimed.id}:ambiguous`,
                    kind: "user",
                    title: "Possible external effect",
                    excerpt: options.ambiguousExcerpt,
                  },
                ],
              });
              await notify(
                failed !== null,
                claimed,
                "task.failed",
                String(claimed.attempts),
                "Task failed",
                options.ambiguousDetail,
              );
              await finish();
              report.skipped.push(item.key);
              return null;
            }
            const next = claimed.attempts + 1;
            const recovered = await store.settleTask(claimed.id, {
              ifAttempts: claimed.attempts,
              attempts: next,
            });
            if (!recovered) {
              await finish();
              report.skipped.push(item.key);
              return null;
            }
            return next;
          }
          if (claimed.status !== options.entryStatus) {
            await finish();
            report.skipped.push(item.key);
            return null;
          }
          const running = await store.settleTask(claimed.id, {
            ifAttempts: claimed.attempts,
            status: "running",
            // T04×T07: the claim names the status its read saw — a
            // cancel/pause CAS landing in the read-then-claim window (those
            // move the row without touching attempts) is refused here, not
            // overwritten.
            ifStatus: [options.entryStatus],
          });
          if (!running) {
            await finish();
            report.skipped.push(item.key);
            return null;
          }
          return claimed.attempts;
        };
        /*
         * T10 (§7 Monitor): a monitor Task's check cycle. The queue's runAt
         * handed the row over at-or-after nextCheckAt — the database's
         * clock on both ends, which is what "a due check runs at-or-after
         * that instant" means. Only a `scheduled` row checks; a cancelled
         * or paused one is skipped with its queue row and never
         * re-offered, so stop (T04/T05) prevents later offers. One check
         * runs through the injectable checkMonitor seam; T11 dedups its
         * observation against the committed cursor and backs off failures.
         * A new observation lands as one evidence row; after the check,
         * nextCheckAt re-arms now+interval (or the backoff delay) and the
         * row returns to
         * `scheduled`; a stop that lands mid-check waits for this same
         * safe boundary, exactly as a turn's end does.
         */
        if (task?.kind === "monitor") {
          if (
            task.monitorCondition === undefined ||
            task.nextCheckAt === undefined
          ) {
            // Not the runner's to run: a malformed row is skipped loudly
            // rather than guessed at.
            await finish();
            report.skipped.push(item.key);
            continue;
          }
          /*
           * T07's shape, a monitor's: a lease lost with prior observations
           * already recorded may have been seen, so it fails rather than
           * replays; an effect-free one re-runs the check as a new
           * generation. T06×T07: only observations the CURRENT generation
           * committed count — the rows a retry retained are stamped with the
           * generation that wrote them, history with a recorded outcome,
           * never an unknown effect. (The shared recoverLease prologue, M42.)
           */
          const generation = await recoverLease(task, {
            entryStatus: "scheduled",
            priorEffect: task.evidence.some((row) =>
              ofCurrentAttempt(row as { attempt?: number }, task.attempts),
            ),
            ambiguousExcerpt:
              "The check's lease was lost; the observation may have been recorded.",
            ambiguousDetail:
              "The check's lease was lost; the outcome was ambiguous.",
          });
          if (generation === null) continue;
          const intervalMs = task.monitorCondition.intervalMinutes * 60_000;
          const dueAt = task.nextCheckAt;
          // The evidence row a NEW observation leaves, keyed by its due
          // instant — one row per committed observation, carrying the
          // match verdict T12's notification reads.
          const observationEvidence = (excerpt: string, matched: boolean) => [
            {
              id: `${task.id}:observation:${dueAt.toISOString()}`,
              kind: "web" as const,
              title: "Monitor observation",
              excerpt: excerpt.slice(0, EXCERPT_MAX),
              matched,
            },
          ];
          // T11: the row's whole evidence after this check, capped to the
          // latest MONITOR_EVIDENCE_CAP rows — a drifting source commits a
          // new observation almost every check, and every settle rewrites
          // the whole jsonb column, so the oldest rows are pruned here.
          const cappedEvidence = (appended: OpenMuseEvidence[]) =>
            ([...task.evidence, ...appended] as OpenMuseEvidence[]).slice(
              -MONITOR_EVIDENCE_CAP,
            );
          try {
            /*
             * The check is deadline-bound exactly as a turn is: a producer
             * that hangs (a source that never answers) loses the race and
             * lands in the backoff below, instead of holding the sweep —
             * and, behind the serial production wiring, the whole Task
             * pipeline — forever.
             */
            const checkSignal = AbortSignal.timeout(deadlineMs);
            const check = checkMonitor(task);
            // A check that loses the race below is ignored, never unhandled.
            check.catch(() => {});
            const { observation } = await Promise.race([
              check,
              new Promise<never>((_, reject) =>
                checkSignal.addEventListener("abort", () =>
                  reject(
                    new Error(`Monitor check timed out after ${deadlineMs}ms`, {
                      cause: checkSignal.reason,
                    }),
                  ),
                ),
              ),
            ]);
            /*
             * T11: the observation's identity, hashed against the
             * committed cursor. An equal hash is the SAME observation —
             * no second evidence row, no match signal — even across
             * restarts, because the cursor lives on the row. A new one
             * commits a single row and moves the cursor.
             */
            const observed = normalizeObservation(
              task.monitorCondition,
              observation,
            );
            const hash = observationHash(
              task.id,
              observed.source,
              observed.value,
            );
            const repeated = task.lastObservationHash === hash;
            const matched = monitorMatched(
              task.monitorCondition,
              observed.value,
              {
                repeated,
                hadCursor: task.lastObservationHash !== undefined,
              },
            );
            const evidence = repeated
              ? []
              : observationEvidence(observation, matched);
            const cursor = repeated
              ? {}
              : { lastObservationHash: hash, lastObservationAt: now() };
            // T04/T05: a stop that landed mid-check waits for this safe
            // boundary; the observation already happened, so it is recorded
            // beside the terminal-for-now status, never fabricated away.
            const after = await store.get(task.ownerUserId, task.id);
            const next = new Date(now().getTime() + intervalMs);
            if (after?.cancellationRequested) {
              await store.settleTask(task.id, {
                ifAttempts: generation,
                status: "cancelled",
                ...cursor,
                monitorFailureStreak: 0,
                setEvidence: cappedEvidence([
                  ...evidence,
                  {
                    id: `${task.id}:cancel`,
                    kind: "user",
                    title: "Cancelled",
                    excerpt:
                      "Cancelled while checking; the observation was recorded.",
                  },
                ]),
              });
              await finish();
              report.skipped.push(item.key);
              continue;
            }
            if (after?.pauseRequested) {
              await store.settleTask(task.id, {
                ifAttempts: generation,
                status: "paused",
                ...cursor,
                monitorFailureStreak: 0,
                setEvidence: cappedEvidence([
                  ...evidence,
                  {
                    id: `${task.id}:pause`,
                    kind: "user",
                    title: "Paused",
                    excerpt:
                      "Paused while checking; the observation was recorded.",
                  },
                ]),
              });
              await finish();
              report.skipped.push(item.key);
              continue;
            }
            const landed = await store.settleTask(task.id, {
              ifAttempts: generation,
              status: "scheduled",
              nextCheckAt: next,
              ...cursor,
              // T11: any completed check — repeated or new — is a success:
              // the streak clears and the interval re-arms, not the backoff.
              monitorFailureStreak: 0,
              setEvidence: cappedEvidence(evidence),
            });
            await finish();
            // The next check is its own piece of work under a fresh queue
            // identity, offered at the re-armed instant — runAt is the
            // schedule, the sweep claims it when due.
            if (landed) {
              await offerContinuation(task, next);
              // T12: a NEW observation that matched emits monitor.matched
              // keyed by the observation's identity hash; a repeated one
              // is the same observation and emits nothing.
              if (!repeated && matched) {
                await notify(
                  true,
                  task,
                  "monitor.matched",
                  hash,
                  "Monitor matched",
                  observation.slice(0, DETAIL_MAX),
                );
              }
            }
            report[landed ? "ran" : "skipped"].push(item.key);
          } catch (error) {
            /*
             * T11: a failed check completes its cycle but backs off — the
             * streak's delay (15/30/60 minutes doubling, capped at six
             * hours) replaces the interval, and the failure stays a
             * visible note on the evidence.
             */
            const streak = task.monitorFailureStreak + 1;
            const next = new Date(
              now().getTime() + backoffMinutes(streak) * 60_000,
            );
            const failureEvidence = [
              {
                id: `${task.id}:observation:${dueAt.toISOString()}`,
                kind: "web" as const,
                title: "Check failed",
                excerpt: detail(error),
              },
            ];
            /*
             * T04/T05: the failure path is as safe a boundary as the success
             * path above — a stop that landed mid-check is consumed HERE
             * before the backoff re-arms, or a persistently failing source
             * would wedge the stop forever behind its own retries (the row
             * reads scheduled/running the whole while).
             */
            const after = await store.get(task.ownerUserId, task.id);
            if (
              after &&
              (after.cancellationRequested || after.pauseRequested)
            ) {
              await store.settleTask(task.id, {
                ifAttempts: generation,
                status: after.cancellationRequested ? "cancelled" : "paused",
                monitorFailureStreak: streak,
                setEvidence: cappedEvidence(failureEvidence),
              });
              await finish();
              report.skipped.push(item.key);
              continue;
            }
            const landed = await store.settleTask(task.id, {
              ifAttempts: generation,
              status: "scheduled",
              nextCheckAt: next,
              monitorFailureStreak: streak,
              setEvidence: cappedEvidence(failureEvidence),
            });
            await finish();
            if (landed) {
              await offerContinuation(task, next);
            }
            report.skipped.push(item.key);
          }
          continue;
        }
        /*
         * T13 (§7 Finance): a finance Task's whole run — read the owner's
         * CSV File, parse and total it with the ported parser, and upload
         * the summary as a new owner-scoped File linked through
         * artifactIds. No Bot turn: the parser is the executor. The whole
         * CSV is refused or summarized — never a partial tracker — and a
         * refusal settles the row failed with the offending row number
         * and NO artifact. T07's recovery shape, a finance run's: a lease
         * lost before the settle re-runs (the artifact upload is
         * idempotent under the Task's owner-scoped key, so a re-run
         * converges on one artifact); anything ambiguous fails, never
         * replays blind.
         */
        if (task?.kind === "finance") {
          /*
           * T06×T07: only evidence the CURRENT generation wrote counts — a
           * retry's retained rows are stamped history with a recorded
           * outcome, not an unknown external effect. (Shared recoverLease
           * prologue, M42.)
           */
          const generation = await recoverLease(task, {
            entryStatus: "queued",
            priorEffect: task.evidence.some((row) =>
              ofCurrentAttempt(row as { attempt?: number }, task.attempts),
            ),
            ambiguousExcerpt: RECONCILIATION_DETAIL,
            ambiguousDetail: RECONCILIATION_DETAIL,
          });
          if (generation === null) continue;
          try {
            // §5: a foreign, missing or tombstoned File answers null —
            // the row records the unread input, never guesses at it.
            const owned = await files.getOwnedFile(
              task.ownerUserId,
              task.prompt ?? "",
            );
            if (!owned)
              throw new Error(
                "The task's CSV file could not be read; it may be missing or deleted.",
              );
            const summary = analyzeSpending(
              new TextDecoder().decode(await owned.read()),
            );
            const artifact = await files.upload({
              ownerUserId: task.ownerUserId,
              name: `finance-summary-${task.id}.json`,
              mimeType: "application/json",
              bytes: Buffer.from(
                `${JSON.stringify(
                  { ...summary, convention: AMOUNT_CONVENTION },
                  null,
                  2,
                )}\n`,
                "utf8",
              ),
              // One artifact per Task across re-runs: the files store's
              // owner-scoped idempotency key.
              idempotencyKey: `openmuse-finance:${task.id}`,
            });
            const excerpt =
              `income ${summary.income}, spending ${summary.spending}, ` +
              `saved ${summary.saved}, ${summary.count} transactions`;
            const summaryEvidence = [
              {
                id: `${task.id}:finance`,
                kind: "file" as const,
                title: "Transaction summary",
                excerpt: excerpt.slice(0, EXCERPT_MAX),
              },
            ];
            // T04/T05: a stop that landed mid-run waits for this safe
            // boundary; the artifact already exists, so it is linked
            // beside the terminal-for-now status, never fabricated away.
            const after = await store.get(task.ownerUserId, task.id);
            if (after?.cancellationRequested) {
              await store.settleTask(task.id, {
                ifAttempts: generation,
                status: "cancelled",
                appendedArtifactIds: [artifact.file.id],
                appendedEvidence: [
                  ...summaryEvidence,
                  {
                    id: `${task.id}:cancel`,
                    kind: "user",
                    title: "Cancelled",
                    excerpt:
                      "Cancelled while summarizing; the artifact was recorded.",
                  },
                ],
              });
              await finish();
              report.skipped.push(item.key);
              continue;
            }
            if (after?.pauseRequested) {
              await store.settleTask(task.id, {
                ifAttempts: generation,
                status: "paused",
                appendedArtifactIds: [artifact.file.id],
                appendedEvidence: [
                  ...summaryEvidence,
                  {
                    id: `${task.id}:pause`,
                    kind: "user",
                    title: "Paused",
                    excerpt:
                      "Paused while summarizing; the artifact was recorded.",
                  },
                ],
              });
              await finish();
              report.skipped.push(item.key);
              continue;
            }
            const landed = await store.settleTask(task.id, {
              ifAttempts: generation,
              status: "succeeded",
              appendedArtifactIds: [artifact.file.id],
              appendedEvidence: summaryEvidence,
              appendedSteps: [
                {
                  id: "run",
                  title: "Run",
                  dependsOn: [],
                  status: "succeeded",
                  result: excerpt,
                },
              ],
            });
            await finish();
            await notify(
              landed !== null,
              task,
              "task.succeeded",
              String(generation),
              "Task succeeded",
              excerpt,
            );
            report[landed ? "ran" : "skipped"].push(item.key);
          } catch (error) {
            // The whole CSV refused: the row carries the parser's row
            // number, and no artifact exists.
            const failed = await store.settleTask(task.id, {
              ifAttempts: generation,
              status: "failed",
              appendedEvidence: [
                {
                  id: `${task.id}:finance`,
                  kind: "user",
                  title: "Import refused",
                  excerpt: detail(error),
                },
              ],
              appendedSteps: [
                {
                  id: "run",
                  title: "Run",
                  dependsOn: [],
                  status: "failed",
                  result: detail(error),
                },
              ],
            });
            await finish();
            await notify(
              failed !== null,
              task,
              "task.failed",
              String(generation),
              "Task failed",
              detail(error),
            );
            report.skipped.push(item.key);
          }
          continue;
        }
        /*
         * T15 (§7 document flow): a document Task's two runs. The first
         * sweep inspects the bound PDF File (F05's seam) and opens ONE T08
         * wait carrying the required field schema, unsupported fields shown
         * on the evidence; the owner's answer consumes the wait (T08's CAS)
         * and the re-offered run fills ONE derived version through F06's
         * validateFill+applyFill — the source File row is only ever read,
         * so its sha never moves. No Bot turn: the inspection and the fill
         * are the executors, exactly as finance's parser is.
         */
        if (task?.kind === "document") {
          const carriage = documentTaskInput(task.prompt);
          if (!carriage) {
            // Not the runner's to run: a malformed row is skipped loudly
            // rather than guessed at.
            await finish();
            report.skipped.push(item.key);
            continue;
          }
          /*
           * T16 (§7 reviewed reply): the parked reply's poll. A decision
           * webhook is NOT invented — the park re-offered the row, and each
           * sweep reads the proposal's status, one cheap single-row read.
           * Undecided or mid-send parks again; a settled proposal completes
           * the task with the §6 receipt on the evidence; denial, expiry or
           * cancellation fails it with the reason (the filled File is
           * retained — never deleted); outcome_unknown parks an uncertain
           * marker and STOPS polling — R04's operator reconciliation owns
           * that tail, and this task never proposes or sends again.
           */
          const reviewWait = reviewWaitOf(task.wait);
          if (task.status === "waiting_review") {
            if (reviewWait === null) {
              // Not the runner's to run: a waiting_review row without a
              // review wait is skipped loudly rather than guessed at.
              await finish();
              report.skipped.push(item.key);
              continue;
            }
            const reoffer = (delayMs?: number) =>
              /*
               * The poll's continuation offer goes through the same
               * loud-on-failure seam as every other re-offer: the row is
               * parked and would be stranded silently if the raw offer's
               * throw unwound into the per-item catch. delayMs backs a
               * failing poll's retry off (the fresh queue key means the
               * queue's own attempts cap can never bound it).
               */
              offerContinuation(
                task,
                delayMs === undefined
                  ? undefined
                  : new Date(now().getTime() + delayMs),
              );
            try {
              const observed = await review.resolve(
                task.ownerUserId,
                reviewWait.proposalId,
              );
              if (
                observed.status === "awaiting_review" ||
                observed.status === "executing"
              ) {
                /*
                 * No decision yet (or the send is mid-flight): the next sweep
                 * polls again. The read never sends anything. A stop that
                 * landed mid-run rides the park (the store's cancel matrix
                 * 409s waiting_review, so this boundary is the owner's only
                 * cancel path for a parked reply) and is consumed here —
                 * the monitor branch's safe-boundary pattern — rather than
                 * re-offering a task the owner asked to stop forever.
                 */
                const after = await store.get(task.ownerUserId, task.id);
                if (after?.cancellationRequested) {
                  await store.settleTask(task.id, {
                    ifAttempts: task.attempts,
                    status: "cancelled",
                    appendedEvidence: [
                      {
                        id: `${task.id}:cancel`,
                        kind: "user",
                        title: "Cancelled",
                        excerpt: "Cancelled while awaiting the review.",
                      },
                    ],
                  });
                  await finish();
                  report.skipped.push(item.key);
                  continue;
                }
                await finish();
                await reoffer();
                report.ran.push(item.key);
                continue;
              }
              if (observed.status === "outcome_unknown") {
                // The uncertain tail, surfaced once: the marker is the
                // whole statement, and no further poll or proposal follows.
                await store.settleTask(task.id, {
                  ifAttempts: task.attempts,
                  status: "waiting_review",
                  appendedEvidence: [
                    {
                      id: `${task.id}:uncertain`,
                      kind: "user",
                      title: "Reply outcome uncertain",
                      excerpt:
                        "The reply send's outcome is unknown; an operator must reconcile it. This task never resends.",
                    },
                  ],
                });
                await finish();
                report.ran.push(item.key);
                continue;
              }
              if (observed.status === "succeeded") {
                // Approval sent once: the task completes with the §6
                // receipt reference (attempt, provider message) on the
                // evidence, linked to this Task.
                const receipt = observed.receipt;
                const providerRef = receipt?.providerRef;
                const excerpt =
                  `reply sent; receipt attempt ${receipt?.attemptId ?? "unknown"}` +
                  (providerRef !== null && providerRef !== undefined
                    ? `, provider message ${providerRef}`
                    : "");
                const landed = await store.settleTask(task.id, {
                  ifAttempts: task.attempts,
                  status: "succeeded",
                  appendedEvidence: [
                    {
                      id: `${task.id}:receipt`,
                      kind: "mail",
                      title: "Reply sent",
                      excerpt: excerpt.slice(0, EXCERPT_MAX),
                    },
                  ],
                  appendedSteps: [
                    {
                      id: "run",
                      title: "Run",
                      dependsOn: [],
                      status: "succeeded",
                      result: excerpt,
                    },
                  ],
                });
                await finish();
                await notify(
                  landed !== null,
                  task,
                  "task.succeeded",
                  String(task.attempts),
                  "Task succeeded",
                  excerpt,
                );
                report[landed !== null ? "ran" : "skipped"].push(item.key);
                continue;
              }
              // Denied, expired, cancelled, or a definite send failure:
              // the task fails with the reason; the filled File row is
              // retained (no delete), and no send ever follows.
              const retained = "the filled document is retained";
              const reasonByStatus: Partial<
                Record<typeof observed.status, string>
              > = {
                denied: `The reply was denied; ${retained}.`,
                expired: `The review expired without a decision; ${retained}.`,
                cancelled: `The review was cancelled; ${retained}.`,
              };
              const reason =
                reasonByStatus[observed.status] ??
                observed.error ??
                `The reply send failed; ${retained}.`;
              const failed = await store.settleTask(task.id, {
                ifAttempts: task.attempts,
                status: "failed",
                appendedEvidence: [
                  {
                    id: `${task.id}:review-outcome`,
                    kind: "mail",
                    title: "Reply not sent",
                    excerpt: reason.slice(0, EXCERPT_MAX),
                  },
                ],
                appendedSteps: [
                  {
                    id: "run",
                    title: "Run",
                    dependsOn: [],
                    status: "failed",
                    result: reason,
                  },
                ],
              });
              await finish();
              await notify(
                failed !== null,
                task,
                "task.failed",
                String(task.attempts),
                "Task failed",
                reason,
              );
              report[failed !== null ? "ran" : "skipped"].push(item.key);
              continue;
            } catch {
              /*
               * A poll that cannot read is retried by a later sweep — the row
               * keeps its park, and nothing here can send anything. The
               * re-offer is backed off (backoffMinutes(2), the monitor failure
               * branch's ceiling): the continuation key is a fresh UUID, so
               * the queue's attempts counter restarts at 1 with every re-offer
               * and maxAttempts alone can never bound a persistently failing
               * poll — the runAt is what makes the retry frequency finite.
               */
              await finish();
              await reoffer(backoffMinutes(2) * 60_000);
              report.skipped.push(item.key);
              continue;
            }
          }
          /*
           * T07's shape, a document's: an interrupted run already carries
           * evidence (the inspect evidence at least) by the fill stage, and
           * the derived version may exist, so it fails with the
           * reconciliation-wait detail instead of replaying a fill. An
           * effect-free one (crashed before the wait opened) re-runs the
           * inspection as a new generation. T06×T07: the inspect evidence
           * shares the fill run's generation (the wait answer re-offers
           * within it), while a retry's retained rows are stamped history
           * and do not block the re-run. (Shared recoverLease prologue, M42.)
           */
          const generation = await recoverLease(task, {
            entryStatus: "queued",
            priorEffect: task.evidence.some((row) =>
              ofCurrentAttempt(row as { attempt?: number }, task.attempts),
            ),
            ambiguousExcerpt: RECONCILIATION_DETAIL,
            ambiguousDetail: RECONCILIATION_DETAIL,
          });
          if (generation === null) continue;
          try {
            // §5: a foreign, missing or tombstoned File answers null — the
            // row records the unread input, never guesses at it.
            const owned = await files.getOwnedFile(
              task.ownerUserId,
              carriage.fileId,
            );
            if (!owned)
              throw new Error(
                "The task's document file could not be read; it may be missing or deleted.",
              );
            const answer = task.wait?.answer;
            if (answer === undefined) {
              /*
               * The inspect run: which fields the wait asks for is decided
               * by the PDF itself — supported text/checkbox fields become
               * the schema, unsupported ones are shown on the evidence so
               * the owner knows what will NOT be filled.
               */
              const inspection = await inspectPdfDocument(
                await owned.read(),
                extract,
              );
              if (inspection.supported.length === 0)
                throw new Error(
                  "The document has no supported fields to fill.",
                );
              const fields: OpenMuseWaitField[] = inspection.supported.map(
                (field) => ({
                  name: field.name,
                  type: field.type === "text" ? "string" : "boolean",
                }),
              );
              const question =
                `Which values should the document carry? ` +
                inspection.supported
                  .map(
                    (field) =>
                      `${field.name} (${field.type === "text" ? "text" : "checkbox"})`,
                  )
                  .join(", ") +
                `.`;
              const inspected = `supported: ${
                inspection.supported.map((field) => field.name).join(", ") ||
                "none"
              }; unsupported: ${
                inspection.unsupported
                  .map((field) => `${field.fieldName} (${field.reason})`)
                  .join(", ") || "none"
              }`;
              const parked = await store.openWait(task.id, {
                ifAttempts: generation,
                question,
                fields,
                appendedSteps: [
                  {
                    id: "run",
                    title: "Run",
                    dependsOn: [],
                    status: "waiting",
                    result: question,
                  },
                ],
                appendedEvidence: [
                  {
                    id: `${task.id}:inspect`,
                    kind: "file",
                    title: "Document inspected",
                    excerpt: inspected.slice(0, EXCERPT_MAX),
                  },
                ],
              });
              await finish();
              if (parked) {
                await notify(
                  true,
                  task,
                  "task.waiting_input",
                  String(generation),
                  "Task needs your answer",
                  question,
                );
              }
              report[parked ? "ran" : "skipped"].push(item.key);
            } else {
              /*
               * The fill run: the wait's answer is the values map. The
               * bound version must still be the File's current one — a
               * fill that landed between wait and answer changes the
               * bytes, so filling would silently parent the wrong copy.
               */
              if (owned.file.versionId !== carriage.versionId)
                throw new Error(
                  "The document changed since the task was created; the bound version is no longer current.",
                );
              const bytes = await owned.read();
              // M26's single parse, the runner's fill path too: the
              // inspection and the adapter share one memoized load.
              let parsedDoc: PDFDocument | undefined;
              const loadOnce = async () => {
                parsedDoc ??= await loadPdfDocument(bytes);
                return parsedDoc;
              };
              const docExtractor: PdfFieldExtractor =
                extract === defaultPdfExtract
                  ? async () => extractPdfDocument(await loadOnce())
                  : extract;
              const inspection = await inspectPdfDocument(bytes, docExtractor);
              const typed = validateFill(inspection, answer);
              const fillLoad =
                parsedDoc !== undefined
                  ? loadOnce
                  : () => loadPdfDocument(bytes);
              const filled = await applyFill(
                fillLoad,
                inspection,
                typed,
                fillAdapter,
              );
              const version = await files.appendVersion({
                ownerUserId: task.ownerUserId,
                fileId: carriage.fileId,
                bytes: filled,
                parentVersionId: carriage.versionId,
                values: typed,
              });
              if (!version)
                throw new Error(
                  "The document file could not be written; it may be missing or deleted.",
                );
              if (version === "stale-parent")
                throw new Error(
                  "The document's version is no longer current; the fill lost its race with a newer version.",
                );
              const excerpt =
                `filled version ${version.versionId} from ${carriage.versionId} ` +
                `with ${Object.keys(typed).join(", ")}`;
              const fillEvidence: OpenMuseEvidence[] = [
                {
                  id: `${task.id}:fill`,
                  kind: "file",
                  title: "Document filled",
                  excerpt: excerpt.slice(0, EXCERPT_MAX),
                },
              ];
              // T04/T05: a stop that landed mid-fill waits for this safe
              // boundary; the derived version already exists, so it is
              // linked beside the terminal-for-now status.
              const after = await store.get(task.ownerUserId, task.id);
              if (after?.cancellationRequested) {
                await store.settleTask(task.id, {
                  ifAttempts: generation,
                  status: "cancelled",
                  appendedArtifactIds: [version.versionId],
                  appendedEvidence: [
                    ...fillEvidence,
                    {
                      id: `${task.id}:cancel`,
                      kind: "user",
                      title: "Cancelled",
                      excerpt:
                        "Cancelled while filling; the derived version was recorded.",
                    },
                  ],
                });
                await finish();
                report.skipped.push(item.key);
                continue;
              }
              if (after?.pauseRequested) {
                await store.settleTask(task.id, {
                  ifAttempts: generation,
                  status: "paused",
                  appendedArtifactIds: [version.versionId],
                  appendedEvidence: [
                    ...fillEvidence,
                    {
                      id: `${task.id}:pause`,
                      kind: "user",
                      title: "Paused",
                      excerpt:
                        "Paused while filling; the derived version was recorded.",
                    },
                  ],
                });
                await finish();
                report.skipped.push(item.key);
                continue;
              }
              if (carriage.reply !== undefined) {
                /*
                 * T16: the fill's successor — the reviewed reply. ONE
                 * gmail.send proposal through the reviewed-actions seam,
                 * binding the carriage's reply target, the connected
                 * account and generation (requireConnection's 409 surfaces
                 * HERE, pre-proposal — never fabricated past), and the
                 * EXACT derived version as the attachment. The park is one
                 * CAS'd write carrying the §7 review wait (the proposal
                 * binding), the derived version on artifactIds and the fill
                 * evidence; T12's task.waiting_review notification's first
                 * producer is this park. The re-offer is the poll — no
                 * webhook is invented.
                 */
                const proposed = await review.propose({
                  ownerUserId: task.ownerUserId,
                  payload: carriage.reply,
                  attachmentVersionIds: [version.versionId],
                });
                const parked = await store.openReviewWait(task.id, {
                  ifAttempts: generation,
                  question:
                    "Send the reviewed reply with the filled document attached?",
                  proposalId: proposed.proposalId,
                  appendedArtifactIds: [version.versionId],
                  appendedEvidence: [
                    ...fillEvidence,
                    {
                      id: `${task.id}:review`,
                      kind: "mail",
                      title: "Reply prepared for review",
                      excerpt: `proposal ${proposed.proposalId}`,
                    },
                  ],
                  appendedSteps: [
                    {
                      id: "run",
                      title: "Run",
                      dependsOn: [],
                      status: "waiting",
                      result:
                        "Awaiting the owner's review of the prepared reply.",
                    },
                  ],
                });
                await finish();
                if (parked) {
                  /*
                   * The poll this park schedules is its continuation offer:
                   * the same loud-on-failure seam (offerContinuation) every
                   * other landed transition re-offers through — a park that
                   * committed must never lose its notification to a raw
                   * offer's throw.
                   */
                  await offerContinuation(task);
                  await notify(
                    true,
                    task,
                    "task.waiting_review",
                    String(generation),
                    "Task awaits your review",
                    "Approve or deny the prepared reply before it is sent.",
                  );
                }
                report[parked !== null ? "ran" : "skipped"].push(item.key);
                continue;
              }
              const landed = await store.settleTask(task.id, {
                ifAttempts: generation,
                status: "succeeded",
                appendedArtifactIds: [version.versionId],
                appendedEvidence: fillEvidence,
                appendedSteps: [
                  {
                    id: "run",
                    title: "Run",
                    dependsOn: [],
                    status: "succeeded",
                    result: excerpt,
                  },
                ],
              });
              await finish();
              await notify(
                landed !== null,
                task,
                "task.succeeded",
                String(generation),
                "Task succeeded",
                excerpt,
              );
              report[landed ? "ran" : "skipped"].push(item.key);
            }
          } catch (error) {
            // A refused document run settles failed with the reason; the
            // source File was only ever read, and no artifact exists.
            const failed = await store.settleTask(task.id, {
              ifAttempts: generation,
              status: "failed",
              appendedEvidence: [
                {
                  id: `${task.id}:document`,
                  kind: "user",
                  title: "Document flow failed",
                  excerpt: detail(error),
                },
              ],
              appendedSteps: [
                {
                  id: "run",
                  title: "Run",
                  dependsOn: [],
                  status: "failed",
                  result: detail(error),
                },
              ],
            });
            await finish();
            await notify(
              failed !== null,
              task,
              "task.failed",
              String(generation),
              "Task failed",
              detail(error),
            );
            report.skipped.push(item.key);
          }
          continue;
        }
        /*
         * T09: a plan Task's steps carry its graph. One sweep runs ONE
         * ready step — every predecessor succeeded, itself not — through
         * the same runTurn seam with the step title as the turn's
         * instruction, then requeues for the next sweep. A succeeded step
         * is never replayed: readiness is a status check on the durable
         * row, so a restarted worker picks up exactly where the graph
         * stands. Failure stops the plan — the step stays failed, its
         * successors stay pending — until an explicit retry (T06) resets
         * what did not complete.
         */
        const planSteps =
          task?.kind === "plan" ? (task.steps as OpenMuseTaskStep[]) : null;
        const readyStep = planSteps === null ? null : nextPlanStep(planSteps);
        const plan =
          planSteps === null || readyStep === null
            ? null
            : { steps: planSteps, step: readyStep };
        if (
          task?.kind === "plan" &&
          plan === null &&
          task.status === "queued"
        ) {
          /*
           * Unreachable with a route-validated graph and stop-on-failure,
           * but refused loudly rather than run as a prompt turn: a plan
           * without a runnable step can only be a bug or a tampered row.
           */
          const halted = await store.settleTask(task.id, {
            ifAttempts: task.attempts,
            status: "failed",
            setSteps: planSteps ?? [],
            appendedEvidence: [
              {
                id: `${task.id}:plan`,
                kind: "user",
                title: "Plan halted",
                excerpt: "No step of this plan is runnable.",
              },
            ],
          });
          await notify(
            halted !== null,
            task,
            "task.failed",
            String(task.attempts),
            "Task failed",
            "No step of this plan is runnable.",
          );
          await finish();
          report.skipped.push(item.key);
          continue;
        }
        /*
         * T07: a claim whose row is already `running` is a lost lease come
         * back — the queue re-offered it after expiry, so the item's
         * attempts (its handed-out count) is more than one. Only a provably
         * effect-free previous attempt is re-run, as a NEW generation:
         * attempts+1 in a CAS, so a second recovering sweep cannot
         * double-bump and the stale one cannot settle. Anything that may
         * already have acted is failed with the reconciliation-wait detail
         * instead of replayed. T06×T07: "effect-free" reads the CURRENT
         * generation only — a retry stamps the rows it retains with the
         * generation that wrote them, so the failed attempt's recorded
         * outcome is history, not a possible external effect; an in-flight
         * step (status running) always counts, whatever its stamp.
         */
        let generation: number;
        /*
         * The generic branch's own recovery prologue — deliberately NOT the
         * shared recoverLease above (M42): this one's priorEffect also
         * reads STEPS (a plan's in-flight step counts whatever its stamp),
         * and its ambiguous settle writes the step graph (T09), not an
         * evidence row. Same shape, genuinely different policy — keep the
         * two in sync by eye when the recovery heuristic changes.
         */
        if (task && task.status === "running" && item.attempts > 1) {
          const priorEffect =
            task.evidence.some((row) =>
              ofCurrentAttempt(row as { attempt?: number }, task.attempts),
            ) ||
            task.steps.some(
              (step) =>
                (step as OpenMuseTaskStep).status === "running" ||
                ((step as OpenMuseTaskStep).status !== "pending" &&
                  ofCurrentAttempt(step as OpenMuseTaskStep, task.attempts)),
            );
          if (priorEffect) {
            const failed = await store.settleTask(task.id, {
              ifAttempts: task.attempts,
              status: "failed",
              // T09: a plan's graph is never appended to — an interrupted
              // in-flight step lands failed with the reconciliation
              // detail, succeeded steps stay succeeded, untouched
              // successors stay pending.
              ...(task.kind === "plan"
                ? {
                    setSteps: (task.steps as OpenMuseTaskStep[]).map((step) =>
                      step.status === "running"
                        ? {
                            ...step,
                            status: "failed" as const,
                            result: RECONCILIATION_DETAIL,
                          }
                        : step,
                    ),
                  }
                : {
                    appendedSteps: [
                      {
                        id: "run",
                        title: "Run",
                        dependsOn: [],
                        status: "failed",
                        result: RECONCILIATION_DETAIL,
                      },
                    ],
                  }),
            });
            await finish();
            await notify(
              failed !== null,
              task,
              "task.failed",
              String(task.attempts),
              "Task failed",
              RECONCILIATION_DETAIL,
            );
            report.skipped.push(item.key);
            continue;
          }
          // Captured before the bump: a store seam may hand back the row it
          // just mutated, and the generation must not read through it.
          const next = task.attempts + 1;
          const recovered = await store.settleTask(task.id, {
            ifAttempts: task.attempts,
            attempts: next,
          });
          if (!recovered) {
            // Another sweep owns the recovery generation; this claim is done.
            await finish();
            report.skipped.push(item.key);
            continue;
          }
          generation = next;
        } else if (task?.status !== "queued") {
          /*
           * Only a queued row runs. Everything else a claim could hand
           * over — gone, settled off-queue (cancelled), paused before the
           * claim, running under another claim (a resume's fresh key beside
           * an old unconsumed one: one execution authority per Task),
           * waiting, scheduled — is skipped, and the queue row with it.
           * Never a turn for anything but queued work.
           */
          await finish();
          report.skipped.push(item.key);
          continue;
        } else {
          // The queued→running write carries the generation CAS: two sweeps
          // racing one row cannot both believe they are the execution. For
          // a plan (T09) the same write marks the ready step running, so
          // the claim and the step transition are one CAS and an
          // interrupted claim is never mistaken for a step never started.
          const running = await store.settleTask(task.id, {
            ifAttempts: task.attempts,
            status: "running",
            // T04×T07: the queued read is the precondition — a cancelled or
            // paused row is never claimed into a run.
            ifStatus: ["queued"],
            ...(plan
              ? {
                  setSteps: withPlanStep(plan.steps, plan.step.id, "running"),
                }
              : {}),
          });
          if (!running) {
            await finish();
            report.skipped.push(item.key);
            continue;
          }
          generation = task.attempts;
        }
        /**
         * Settle the row in ONE write — evidence, step, status — CAS'd on
         * the generation. Atomic, so a crash mid-settle leaves `running`
         * (unknown) rather than a lie, and a stale generation lands none of
         * it. False means refused: the outcome is not ours to report.
         */
        const settle = async (
          status: "succeeded" | "failed",
          step: { status: "succeeded" | "failed"; result: string },
          evidence: OpenMuseEvidence[],
        ) => {
          const landed = await store.settleTask(task.id, {
            ifAttempts: generation,
            status,
            appendedEvidence: [
              {
                id: `${task.id}:prompt`,
                kind: "user",
                title: "Your request",
                // The row carries an excerpt like every other evidence row
                // (the prompt can be 20,000 characters); the audit trail,
                // not the jsonb column, keeps the whole text.
                excerpt: (task.prompt ?? "").slice(0, EXCERPT_MAX),
              },
              ...evidence,
            ],
            appendedSteps: [
              {
                id: "run",
                title: "Run",
                dependsOn: [],
                status: step.status,
                result: step.result,
              },
            ],
          });
          await finish();
          // T12: the transition landed, so its notification follows — the
          // step's own result is the detail the owner reads.
          if (landed) {
            await notify(
              true,
              task,
              status === "succeeded" ? "task.succeeded" : "task.failed",
              String(generation),
              status === "succeeded" ? "Task succeeded" : "Task failed",
              step.result,
            );
          }
          return landed !== null;
        };
        /**
         * T04's cancelled settle: a status note instead of a fabricated run
         * step — the turn's result is discarded, one guarded write carries
         * the note and the terminal status, same contract as `settle`.
         */
        const settleCancelled = async (note: string) => {
          await store.settleTask(task.id, {
            ifAttempts: generation,
            status: "cancelled",
            appendedEvidence: [
              {
                id: `${task.id}:cancel`,
                kind: "user",
                title: "Cancelled",
                excerpt: note,
              },
            ],
          });
          await finish();
        };
        /**
         * T05's paused settle, the cancelled settle's shape: a status note
         * instead of a fabricated run step, the terminal-for-now status in
         * the same guarded write. A later resume requeues; nothing here
         * prevents that.
         */
        const settlePaused = async (note: string) => {
          await store.settleTask(task.id, {
            ifAttempts: generation,
            status: "paused",
            appendedEvidence: [
              {
                id: `${task.id}:pause`,
                kind: "user",
                title: "Paused",
                excerpt: note,
              },
            ],
          });
          await finish();
        };
        try {
          const channel = await channels.direct(
            await actorFor(task.ownerUserId),
            task.botId,
          );
          const initiator: AuditInitiator = {
            kind: "routine",
            id: `openmuse-task:${task.id}`,
          };
          const signal = AbortSignal.timeout(deadlineMs);
          const turn = runTurn({
            ownerUserId: task.ownerUserId,
            routineId: `openmuse-task:${task.id}`,
            agentId: task.botId,
            threadId: channel.threadId,
            // T09: a plan step's turn carries the step's title as its
            // instruction — the graph's own words for what this turn does.
            instruction: plan ? plan.step.title : (task.prompt ?? ""),
            initiator,
            signal,
          });
          // A turn that loses the race below is ignored, never unhandled.
          turn.catch(() => {});
          const { replyText } = await Promise.race([
            turn,
            new Promise<never>((_, reject) =>
              signal.addEventListener("abort", () =>
                // F-TASK-2: losing this race does not stop the turn — it
                // keeps running behind the discarded promise, so its outside
                // effects are unknowable. The ambiguous shape (not a plain
                // failure) is what keeps the row off the retry path and puts
                // the possible effect on the evidence.
                reject(
                  new AmbiguousTurnError(
                    `Task timed out after ${deadlineMs}ms`,
                  ),
                ),
              ),
            ),
          ]);
          // T04/T05: a cancel or pause that landed mid-turn waits for this
          // safe boundary (the turn's end). Cancel wins when both were
          // requested: a cancelled row is never resurrected by a pending
          // pause, and the pause flag dies with the terminal status.
          const after = await store.get(task.ownerUserId, task.id);
          if (after?.cancellationRequested) {
            if (plan) {
              // T09: the step's turn finished — its result is real, so the
              // step lands succeeded (a later resume never replays it) and
              // the task carries the terminal status in the same write.
              await store.settleTask(task.id, {
                ifAttempts: generation,
                status: "cancelled",
                setSteps: withPlanStep(
                  plan.steps,
                  plan.step.id,
                  "succeeded",
                  replyText,
                ),
                appendedEvidence: [
                  {
                    id: `${task.id}:cancel`,
                    kind: "user",
                    title: "Cancelled",
                    excerpt: `Cancelled while running; the step "${plan.step.title}" was allowed to finish.`,
                  },
                ],
              });
              await finish();
            } else {
              await settleCancelled(
                "Cancelled while running; the current step was allowed to finish.",
              );
            }
            report.skipped.push(item.key);
            continue;
          }
          if (after?.pauseRequested) {
            if (plan) {
              // T09: the cancelled settle's shape, for a pause — the
              // finished step stays succeeded, the row parks paused.
              await store.settleTask(task.id, {
                ifAttempts: generation,
                status: "paused",
                setSteps: withPlanStep(
                  plan.steps,
                  plan.step.id,
                  "succeeded",
                  replyText,
                ),
                appendedEvidence: [
                  {
                    id: `${task.id}:pause`,
                    kind: "user",
                    title: "Paused",
                    excerpt: `Paused while running; the step "${plan.step.title}" was allowed to finish.`,
                  },
                ],
              });
              await finish();
            } else {
              await settlePaused(
                "Paused while running; the current step was allowed to finish.",
              );
            }
            report.skipped.push(item.key);
            continue;
          }
          // T08: a turn the classifier flags as waiting ends the run here —
          // one generation-guarded write parks the row `waiting_input` with
          // the wait record, a waiting step and the question on the
          // evidence; the answer's consume re-offers, nothing else does.
          // Plans never wait yet: no runTurn producer can express one
          // (C07/T15 owns that wiring), so a plan step's turn settles by
          // its own success or failure.
          const waiting = plan ? null : inputWaitOf({ replyText });
          if (waiting) {
            const parked = await store.openWait(task.id, {
              ifAttempts: generation,
              question: waiting.question,
              ...(waiting.fields !== undefined
                ? { fields: waiting.fields }
                : {}),
              appendedSteps: [
                {
                  id: "run",
                  title: "Run",
                  dependsOn: [],
                  status: "waiting",
                  result: waiting.question,
                },
              ],
              appendedEvidence: [
                {
                  id: `${task.id}:wait`,
                  kind: "user",
                  title: "Waiting for your answer",
                  excerpt: waiting.question,
                },
              ],
            });
            await finish();
            // T12: the wait that landed is the owner's to see — the
            // question itself is the detail.
            if (parked) {
              await notify(
                true,
                task,
                "task.waiting_input",
                String(generation),
                "Task needs your answer",
                waiting.question,
              );
            }
            report[parked ? "ran" : "skipped"].push(item.key);
            continue;
          }
          if (plan) {
            // T09: land the step succeeded with its result and one evidence
            // entry, then either requeue for the next ready step or — this
            // being the last one — succeed the task.
            const evidenceId = `${task.id}:step:${plan.step.id}`;
            const settledSteps = withPlanStep(
              plan.steps,
              plan.step.id,
              "succeeded",
              replyText,
              [evidenceId],
            );
            const more = settledSteps.some((step) => step.status === "pending");
            const landed = await store.settleTask(task.id, {
              ifAttempts: generation,
              status: more ? "queued" : "succeeded",
              setSteps: settledSteps,
              appendedEvidence: [
                {
                  id: evidenceId,
                  kind: "user",
                  title: plan.step.title,
                  excerpt: replyText.slice(0, EXCERPT_MAX),
                },
              ],
            });
            await finish();
            // The next step is its own piece of work under a fresh queue
            // identity — the same seam resume, retry and an answered wait
            // re-offer through — so one sweep runs one step.
            if (landed && more) {
              await offerContinuation(task);
            }
            // T12: only the LAST step's landing succeeds the Task — the
            // notification is for the Task, not the step.
            if (landed && !more) {
              await notify(
                true,
                task,
                "task.succeeded",
                String(generation),
                "Task succeeded",
                replyText.slice(0, DETAIL_MAX),
              );
            }
            report[landed ? "ran" : "skipped"].push(item.key);
            continue;
          }
          const landed = await settle(
            "succeeded",
            { status: "succeeded", result: replyText },
            [
              {
                id: `${task.id}:result`,
                kind: "user",
                title: "Work completed",
                excerpt: replyText.slice(0, EXCERPT_MAX),
              },
            ],
          );
          // A refused settle is a lost generation: someone else owns the
          // outcome now, so this claim reports a skip, never a ran.
          report[landed ? "ran" : "skipped"].push(item.key);
        } catch (error) {
          if (plan) {
            // T09: failure stops the plan — the step stays failed with the
            // error, its successors stay pending — until an explicit retry
            // (T06) resets what did not complete.
            const failed = await store.settleTask(task.id, {
              ifAttempts: generation,
              status: "failed",
              setSteps: withPlanStep(
                plan.steps,
                plan.step.id,
                "failed",
                isAmbiguousTurn(error)
                  ? `${RECONCILIATION_DETAIL} (${detail(error)})`
                  : detail(error),
              ),
              ...(isAmbiguousTurn(error)
                ? {
                    appendedEvidence: [
                      {
                        id: `${task.id}:ambiguous`,
                        kind: "user",
                        title: "Possible external effect",
                        excerpt:
                          "The turn ended ambiguously; outside effects may have happened.",
                      },
                    ],
                  }
                : {}),
            });
            await finish();
            await notify(
              failed !== null,
              task,
              "task.failed",
              String(generation),
              "Task failed",
              detail(error),
            );
          } else if (isAmbiguousTurn(error)) {
            /*
             * F-TASK-2's shape: the possible effect goes on the evidence
             * and the row says why it will not be retried — one atomic
             * write, so a crash mid-settle cannot leave a markerless
             * running row for the recovery to replay.
             */
            const failed = await store.settleTask(task.id, {
              ifAttempts: generation,
              status: "failed",
              appendedEvidence: [
                {
                  id: `${task.id}:ambiguous`,
                  kind: "user",
                  title: "Possible external effect",
                  excerpt:
                    "The turn ended ambiguously; outside effects may have happened.",
                },
              ],
              appendedSteps: [
                {
                  id: "run",
                  title: "Run",
                  dependsOn: [],
                  status: "failed",
                  result: `${RECONCILIATION_DETAIL} (${detail(error)})`,
                },
              ],
            });
            await finish();
            await notify(
              failed !== null,
              task,
              "task.failed",
              String(generation),
              "Task failed",
              detail(error),
            );
          } else {
            await settle(
              "failed",
              { status: "failed", result: detail(error) },
              [],
            );
          }
          report.skipped.push(item.key);
        }
      } catch (error) {
        /*
         * The row or the channel could not be resolved: over, and the queue
         * row with it, best-effort — the outer claim must survive either way.
         *
         * Round 6 (H7): NEVER silently. This catch also covers transient DB
         * failures from the reads inside the try (store.get, ownerDisabled,
         * the running-settle) — the queue item is destroyed below, no
         * reconciliation scan exists to re-find the row, and a running row
         * would hold its ACTIVE_TASKS_PER_USER slot forever with nobody to
         * consume its cancellation flag. The error is logged (the same
         * severity openmuse-task-reoffer-failed uses) so the stranded row is
         * at least visible to an operator.
         */
        log.error(
          {
            type: "openmuse-task-claim-dispatch-failed",
            key: item.key,
            error: error instanceof Error ? error.message : String(error),
          },
          "openmuse-task-claim-dispatch-failed",
        );
        await finish().catch(() => {});
        report.skipped.push(item.key);
      }
    }
    return holdsSlot ? 1 : 0;
  };
  return {
    /**
     * Run what is due, one claim at a time. O04 (§10 row 4): the sweep
     * loops its claim rounds while a worker slot is free and the queue
     * still hands out due items — one sweep call runs up to the free-slot
     * count, not one item, so production's repeatAfterEach wiring (sweep,
     * then sweep again) drains the backlog a slot at a time instead of one
     * item every interval. A full cap claims nothing: the fifth runnable
     * Task stays queued and visible until a slot frees.
     */
    async sweep(): Promise<{ ran: string[]; skipped: string[] }> {
      const report = { ran: [] as string[], skipped: [] as string[] };
      let held = 0;
      // Per sweep, not per runner: yesterday's continuation must not cap
      // today's drain.
      selfReoffered = false;
      try {
        for (;;) {
          const began = await sweepOnce(report);
          held += began;
          if (began === 0 || selfReoffered) break;
        }
      } finally {
        /*
         * A transient failure inside the loop (queue.claim sits OUTSIDE the
         * per-item try) must not strand the slots this sweep already began:
         * without this release, one throw per slot permanently raises the
         * capacity's running count and claimLimit() answers 0 forever — the
         * process silently stops claiming Tasks until restart.
         */
        for (let index = 0; index < held; index += 1) capacity.end();
      }
      return report;
    },
    /** Drop queue rows for Tasks settled more than a week ago. */
    reap: () =>
      queue.purge({
        kind: OPENMUSE_TASK_KIND,
        olderThanMs: 7 * 24 * 60 * 60_000,
        // T07: a wedged item at the recovery cap is done-with, reaped too.
        maxAttempts: 2,
      }),
  };
}
