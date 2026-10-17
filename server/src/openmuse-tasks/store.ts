import {
  and,
  desc,
  eq,
  inArray,
  lt,
  notInArray,
  or,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import {
  type OpenMuseMonitorCondition,
  type OpenMuseTaskRow,
  type OpenMuseTaskWait,
  type OpenMuseWaitField,
  openmuseTasks,
} from "../db/schema/openmuse";
import type { WorkQueue } from "../work/queue";
import { ACTIVE_TASKS_PER_USER, TASK_LIMIT_MESSAGE } from "./capacity";
import {
  createOwnerDisabled,
  OpenMuseOwnerDisabledError,
} from "../openmuse-personal/shared";

export { OpenMuseOwnerDisabledError };

/**
 * OpenMuse Task store (contracts §7, tickets T01+T02): creation offers the row
 * to the shared WorkQueue, listing reads it back, and the T02 runner settles
 * each row through updateStatus/appendStep/appendEvidence. No second lease
 * system — the queue's database-clock lease is the only one.
 */

/** The WorkQueue kind a queued Task is offered under; the T02 runner claims it. */
export const OPENMUSE_TASK_KIND = "openmuse-task";

export type OpenMuseTaskKind =
  | "agent"
  | "document"
  | "monitor"
  | "finance"
  | "plan";

export type OpenMuseTaskStatus =
  | "queued"
  | "running"
  /*
   * Kept because the pg enum (db/schema/openmuse.ts) carries it and §7's
   * catalogue reserves it, but NOTHING produces it today — no store, runner
   * or route writes it. If a producer ever lands, the matrices must catch
   * up in the same change: countActiveByOwner's notInArray (it already
   * counts as active), the cancel/pause CAS guards (currently 409), and
   * shutdownOwnerTasks' bulk-cancel list (currently omits it).
   */
  | "waiting_approval"
  | "waiting_input"
  /** T16: the reviewed reply's park — the §7 review wait's status. */
  | "waiting_review"
  | "scheduled"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

/** T04×T07: every status but the terminal cancel — the default settle guard. */
const NOT_CANCELLED: OpenMuseTaskStatus[] = [
  "queued",
  "scheduled",
  "running",
  "paused",
  "waiting_input",
  "waiting_review",
  "succeeded",
  "failed",
];

/** The §7 task minimum as stored. `prompt` rides along for T02's runner. */
export type StoredOpenMuseTask = {
  id: string;
  ownerUserId: string;
  botId: string;
  kind: OpenMuseTaskKind;
  status: OpenMuseTaskStatus;
  attempts: number;
  steps: unknown[];
  evidence: unknown[];
  artifactIds: string[];
  createdAt: Date;
  updatedAt: Date;
  idempotencyKey: string | null;
  /** T04: the §7 internal flag; set on a running Task, honoured at the next safe step. */
  cancellationRequested: boolean;
  /** T05: the §7 internal pause flag; same safe-step contract as the cancel one. */
  pauseRequested: boolean;
  /** T06: the retry key the retry CAS last consumed; one key, one new attempt. */
  lastRetryKey: string | null;
  /** T08: the open or answered §7 input wait; absent when the Task never waited. */
  wait?: OpenMuseTaskWait;
  /**
   * T10: the §7 monitor condition and the stored due instant of the next
   * check; absent for every other kind. A monitor row is born `scheduled`
   * rather than `queued` — its work is due at nextCheckAt, never now.
   */
  monitorCondition?: OpenMuseMonitorCondition;
  nextCheckAt?: Date;
  /**
   * T11: the dedup cursor — the identity hash of the last committed
   * observation. An equal hash on the next check is the SAME observation:
   * no second evidence row, no match signal. Absent until the first one.
   */
  lastObservationHash?: string;
  /** T11: when the cursor's observation committed. */
  lastObservationAt?: Date;
  /** T11: consecutive failed checks — the backoff counter, reset on success. */
  monitorFailureStreak: number;
  prompt?: string;
};

export type { OpenMuseMonitorCondition, OpenMuseTaskWait, OpenMuseWaitField };

/**
 * One round of the cancel CAS: `applied` took a transition, `unapplied`
 * changed nothing (the row explains why — idempotent re-request, or a state
 * the matrix refuses), `missing` found no row.
 */
export type TaskCancelCas =
  | { kind: "applied"; task: StoredOpenMuseTask }
  | { kind: "unapplied"; task: StoredOpenMuseTask }
  | { kind: "missing" };

/** T05: the pause and resume CAS outcomes — the same shape T04's cancel CAS returns. */
export type TaskControlCas = TaskCancelCas;

/**
 * T06's retry CAS outcomes: `applied` took the failed→queued swap as a new
 * attempt, `replayed` found its retry key already consumed (the current row
 * answers; no second attempt), `unapplied` changed nothing (the row explains
 * why — not failed), `missing` found no row.
 */
export type TaskRetryCas =
  | { kind: "applied"; task: StoredOpenMuseTask }
  | { kind: "replayed"; task: StoredOpenMuseTask }
  | { kind: "unapplied"; task: StoredOpenMuseTask }
  | { kind: "missing" };

/**
 * T08's answer CAS outcomes: `consumed` took the first valid answer and the
 * queued swap atomically, `replayed` found the wait already answered (the
 * stored result answers; nothing advances twice), `unapplied` found the wait
 * open but the row no longer `waiting_input` (the status machine moved on),
 * `missing` found no row or no wait with that id.
 */
export type TaskWaitAnswerCas =
  | { kind: "consumed"; task: StoredOpenMuseTask }
  | { kind: "replayed"; task: StoredOpenMuseTask }
  | { kind: "unapplied"; task: StoredOpenMuseTask }
  | { kind: "missing" };

/** The row seam the store runs on: drizzle in production, data in tests. */
export type OpenMuseTaskRows = {
  insertTask(task: StoredOpenMuseTask): Promise<void>;
  findTaskByIdempotencyKey(
    ownerUserId: string,
    key: string,
  ): Promise<StoredOpenMuseTask | null>;
  getTask(id: string): Promise<StoredOpenMuseTask | null>;
  listByOwner(
    ownerUserId: string,
    page: { limit: number; before?: { createdAt: Date; id: string } },
  ): Promise<StoredOpenMuseTask[]>;
  listIdsByOwner(ownerUserId: string): Promise<string[]>;
  /**
   * O04 (§10 row 5): the owner's non-terminal Task count — a count query,
   * never a page scan, so the create-time cap check does not pull the
   * steps/evidence jsonb columns across the wire.
   */
  countActiveByOwner(ownerUserId: string): Promise<number>;
  /** The runner's settle seam: status plus jsonb appends, one row, one write. */
  updateTask(
    id: string,
    patch: {
      status?: OpenMuseTaskStatus;
      /** T09: absolute steps for a plan — the graph is replaced, never appended to. */
      steps?: OpenMuseTaskStep[];
      appendedSteps?: OpenMuseTaskStep[];
      /** T11: absolute evidence for a monitor — the capped latest rows, replacing the column. */
      evidence?: OpenMuseEvidence[];
      appendedEvidence?: OpenMuseEvidence[];
      /**
       * T10: a monitor's re-armed due instant, landed in the same atomic
       * settle as the status and evidence of the check that earned it.
       */
      nextCheckAt?: Date;
      /**
       * T11: the observation cursor and the failure streak, landed in the
       * same settle — the hash commits the observation (dedup), the streak
       * drives the backoff. Zero must land, hence !== undefined checks.
       */
      lastObservationHash?: string;
      lastObservationAt?: Date;
      monitorFailureStreak?: number;
      /** T13: artifact File ids appended to artifactIds in the same write. */
      appendedArtifactIds?: string[];
      /** T07: the recovery generation bump, absolute; CAS'd by `ifAttempts`. */
      attempts?: number;
      /** T07: refuse the whole write unless the row still holds this attempts count. */
      ifAttempts?: number;
      /**
       * T04×T07: refuse the whole write unless the row's status is one of these — the
       * claim→running migration names the status its read saw, so a cancel/pause CAS that
       * landed in the read-then-write window (those move queued/scheduled rows without
       * touching attempts) is not silently overwritten and the work not resurrected.
       */
      ifStatus?: OpenMuseTaskStatus[];
    },
  ): Promise<StoredOpenMuseTask | null>;
  ownerDisabled(ownerUserId: string): Promise<boolean>;
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  /** T04: the §7 cancel matrix as one atomic compare-and-swap, or nothing. */
  requestTaskCancel(id: string): Promise<TaskCancelCas>;
  /** T05: the §7 pause matrix as one atomic compare-and-swap, or nothing. */
  requestTaskPause(id: string): Promise<TaskControlCas>;
  /** T05: paused → queued with the flag cleared, as one atomic compare-and-swap. */
  resumeTask(id: string): Promise<TaskControlCas>;
  /**
   * T06: the §7 retry as one atomic compare-and-swap: failed → queued as a new
   * attempt, once per retry key. T09: a plan's reset steps land in the same
   * swap — computed from the failed row, which nothing else may rewrite.
   */
  retryTask(
    id: string,
    retryKey: string | null,
    resetSteps?: OpenMuseTaskStep[],
  ): Promise<TaskRetryCas>;
  /**
   * T08: running → `waiting_input` with the wait record, plus the run's jsonb
   * appends, in one write CAS'd on the attempts generation. Null means a
   * stale generation (or a row that is not running) — nothing lands.
   */
  openTaskWait(
    id: string,
    patch: {
      wait: OpenMuseTaskWait;
      ifAttempts: number;
      appendedSteps?: OpenMuseTaskStep[];
      appendedEvidence?: OpenMuseEvidence[];
    },
  ): Promise<StoredOpenMuseTask | null>;
  /**
   * T16: running → `waiting_review` with the review wait, plus the run's
   * jsonb appends (the derived version's artifact link among them), in one
   * write CAS'd on the attempts generation. Same refusal contract as
   * `openTaskWait`.
   */
  openTaskReviewWait(
    id: string,
    patch: {
      wait: OpenMuseReviewWait;
      ifAttempts: number;
      appendedSteps?: OpenMuseTaskStep[];
      appendedEvidence?: OpenMuseEvidence[];
      appendedArtifactIds?: string[];
    },
  ): Promise<StoredOpenMuseTask | null>;
  /**
   * T08: the answer CAS — the first valid answer sets `answeredAt`, stores
   * the values and swaps `waiting_input` → `queued` atomically; a repeat is
   * classified, never consumed twice.
   */
  answerTaskWait(
    id: string,
    waitId: string,
    answer: Record<string, string | boolean>,
  ): Promise<TaskWaitAnswerCas>;
  /**
   * D02 (§9 work shutdown): the owner-scoped bulk transition a deleted
   * owner's rows land through — queued/scheduled/paused/waiting_* →
   * cancelled; running → the cancellationRequested flag only (T04's
   * contract, the sweep's post-turn finalize lands the status). Two guarded
   * writes, never a blind UPDATE ALL: each WHERE carries the same status
   * guard the per-row CAS helpers do.
   */
  shutdownOwnerTasks(
    ownerUserId: string,
  ): Promise<{ cancelled: string[]; cancelRequested: string[] }>;
  /**
   * D08 (§9): hard-delete the owner's Task rows for the manifest's ids —
   * steps, evidence and the Monitor's condition are columns on the row, so
   * one statement per batch is atomic. Owner-scoped: a foreign id deletes
   * nothing; a repeat (the idempotent re-cleanup) deletes nothing either.
   */
  hardDeleteTasks(ownerUserId: string, ids: string[]): Promise<void>;
};

/** A §7 step: one unit of a run, terminal here at succeeded/failed. */
export type OpenMuseTaskStep = {
  id: string;
  title: string;
  dependsOn: string[];
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  result?: string;
  /** T09: the evidence entries a completed plan step produced. */
  evidenceIds?: string[];
  /**
   * T06×T07: the attempts generation that wrote this row — stamped on the
   * rows a retry retains, so the recovery heuristic reads prior attempts'
   * steps as history (known outcomes) rather than possible external
   * effects. Absent on every row the current generation writes.
   */
  attempt?: number;
};

/** T09: the plan graph a create call offers — statuses land pending. */
export type OpenMusePlanStepInput = {
  id: string;
  title: string;
  dependsOn: string[];
};

/** A §7 evidence entry; kinds mail/file/web/user as the contract fixes them. */
export type OpenMuseEvidence = {
  id: string;
  kind: "mail" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  /**
   * T11: a monitor observation row's match verdict — whether this committed
   * observation satisfies its condition. The seam T12's monitor.matched
   * notification reads; absent on every other evidence entry.
   */
  matched?: boolean;
  /**
   * T06×T07: the attempts generation that wrote this row — stamped on the
   * rows a retry retains, so the recovery heuristic can scope its
   * prior-effect check to the current attempt's rows. Absent on every row
   * the current generation writes (and treated as current, conservatively,
   * wherever it is absent).
   */
  attempt?: number;
};

export type OpenMuseTaskStore = {
  /** Creates one queued task; an existing idempotency key returns the stored row with created=false. */
  create(input: {
    ownerUserId: string;
    botId: string;
    kind: OpenMuseTaskKind;
    prompt?: string;
    /** T09: the plan's step graph, validated at the route; every step lands pending. */
    steps?: OpenMusePlanStepInput[];
    /**
     * T10: the monitor's condition, validated at the route per the §7 matrix;
     * the row lands `scheduled` with nextCheckAt = creation + interval.
     */
    condition?: OpenMuseMonitorCondition;
    idempotencyKey: string | null;
  }): Promise<{ task: StoredOpenMuseTask; created: boolean }>;
  list(
    ownerUserId: string,
    page: { limit: number; cursor?: { createdAt: Date; id: string } },
  ): Promise<{ tasks: StoredOpenMuseTask[] }>;
  get(ownerUserId: string, id: string): Promise<StoredOpenMuseTask | null>;
  /**
   * O04 (§10 row 5): the owner's active (non-terminal) Task count — the
   * number the create-time cap checks, as one count query.
   */
  activeTasks(ownerUserId: string): Promise<number>;
  /**
   * T02's settle seam, T07's generation guard: status, appended steps and
   * evidence, and the one recovery attempts bump, landed in a single write
   * CAS'd on `attempts`. Null means the generation is gone — another sweep
   * recovered the Task and owns its outcome — so a stale attempt lands none
   * of it: not the evidence, not the step, not the status.
   */
  settleTask(
    id: string,
    input: {
      ifAttempts: number;
      status?: OpenMuseTaskStatus;
      /** T04×T07: the statuses this settle's read saw — see the rows seam's own note. */
      ifStatus?: OpenMuseTaskStatus[];
      /** T09: a plan's steps, absolutely — the graph with one step's new status. */
      setSteps?: OpenMuseTaskStep[];
      appendedSteps?: OpenMuseTaskStep[];
      /** T11: a monitor's evidence, absolutely — the capped latest rows. */
      setEvidence?: OpenMuseEvidence[];
      appendedEvidence?: OpenMuseEvidence[];
      /** T13: artifact File ids linked to the Task in the same guarded write. */
      appendedArtifactIds?: string[];
      /** T10: a monitor's re-armed due instant, in the same guarded write. */
      nextCheckAt?: Date;
      /** T11: the observation cursor and streak, in the same guarded write. */
      lastObservationHash?: string;
      lastObservationAt?: Date;
      monitorFailureStreak?: number;
      /** The recovery re-run's generation: previous attempts plus one. */
      attempts?: number;
    },
  ): Promise<StoredOpenMuseTask | null>;
  /** §9 lifecycle hook: refuse work for a disabled owner. */
  disableOwner(ownerUserId: string): Promise<void>;
  restoreOwner(ownerUserId: string): Promise<void>;
  /**
   * T04's §7 cancel matrix, owner-scoped: queued/scheduled/paused →
   * `cancelled` now; running → `requested` (the internal flag, public status
   * stays running until the current safe step ends); anything else →
   * `terminal` with the current status for a 409. Missing or foreign → `missing`.
   */
  requestCancel(
    ownerUserId: string,
    id: string,
  ): Promise<
    | { outcome: "missing" }
    | { outcome: "terminal"; task: StoredOpenMuseTask }
    | { outcome: "cancelled"; task: StoredOpenMuseTask }
    | { outcome: "requested"; task: StoredOpenMuseTask }
  >;
  /**
   * T05's §7 pause matrix, owner-scoped: queued/scheduled → `paused` now;
   * running → `requested` (the internal flag, public status stays running
   * until the current safe step ends); anything else → `terminal` with the
   * current status for a 409. Missing or foreign → `missing`.
   */
  requestPause(
    ownerUserId: string,
    id: string,
  ): Promise<
    | { outcome: "missing" }
    | { outcome: "terminal"; task: StoredOpenMuseTask }
    | { outcome: "paused"; task: StoredOpenMuseTask }
    | { outcome: "requested"; task: StoredOpenMuseTask }
  >;
  /**
   * T05: paused → queued with the pause flag cleared, and the row re-offered
   * to the queue exactly once — the pause→queued CAS is the status guard, so
   * a second resume never enqueues a second run. Anything not paused →
   * `terminal` with the current status for a 409. Missing or foreign → `missing`.
   */
  resumeTask(
    ownerUserId: string,
    id: string,
  ): Promise<
    | { outcome: "missing" }
    | { outcome: "terminal"; task: StoredOpenMuseTask }
    | { outcome: "resumed"; task: StoredOpenMuseTask }
  >;
  /**
   * T06's §7 retry, owner-scoped: `failed` → `queued` as a NEW attempt
   * (attempts+1, cancellation/pause flags cleared, every old step and
   * evidence row retained — each stamped with the generation that wrote it,
   * so T07's recovery reads them as history) with the row re-offered to the
   * queue exactly once. T06×T10: a monitor retries to `scheduled` re-armed
   * now — the runner only executes scheduled monitors, and a retry is an
   * explicit ask for a fresh check. A retry key the CAS already consumed
   * answers `replayed` — the current record, no second attempt. Anything
   * not failed is `terminal` with the current status for a 409. Missing or
   * foreign → `missing`.
   */
  retryTask(
    ownerUserId: string,
    id: string,
    retryKey: string | null,
  ): Promise<
    | { outcome: "missing" }
    | { outcome: "terminal"; task: StoredOpenMuseTask }
    | { outcome: "retried"; task: StoredOpenMuseTask }
    | { outcome: "replayed"; task: StoredOpenMuseTask }
  >;
  /**
   * T08: the runner opens one §7 input wait on a running row — one write
   * carrying the wait record, a waiting step and the question evidence,
   * CAS'd on the attempts generation. Null means the claim was lost or the
   * row is not running: no wait lands. Each call mints a fresh waitId.
   */
  openWait(
    taskId: string,
    input: {
      ifAttempts: number;
      question: string;
      fields?: OpenMuseWaitField[];
      appendedSteps?: OpenMuseTaskStep[];
      appendedEvidence?: OpenMuseEvidence[];
    },
  ): Promise<StoredOpenMuseTask | null>;
  /**
   * T16: the runner parks one §7 review wait on a running row — the T16
   * reply flow's park, carrying the review wait (the reviewed-action proposal
   * binding) beside the fill's appends, CAS'd on the attempts generation.
   * Null means the claim was lost or the row is not running: no park lands.
   */
  openReviewWait(
    taskId: string,
    input: {
      ifAttempts: number;
      question: string;
      proposalId: string;
      appendedSteps?: OpenMuseTaskStep[];
      appendedEvidence?: OpenMuseEvidence[];
      appendedArtifactIds?: string[];
    },
  ): Promise<StoredOpenMuseTask | null>;
  /**
   * T08's §7 answer, owner-scoped: the first valid answer against the exact
   * waitId consumes it atomically and re-offers the row to the queue exactly
   * once (`answered`). A repeat replays the stored result without advancing
   * twice (`replayed`). Malformed values are `invalid` — 400, the wait stays
   * open. A wait whose row moved on from `waiting_input` is `terminal` for a
   * 409. Missing task, foreign owner or unknown waitId → `missing`.
   */
  answerWait(
    ownerUserId: string,
    id: string,
    waitId: string,
    values: Record<string, unknown>,
  ): Promise<
    | { outcome: "missing" }
    | { outcome: "invalid"; error: string }
    | { outcome: "terminal"; task: StoredOpenMuseTask }
    | { outcome: "replayed"; task: StoredOpenMuseTask }
    | { outcome: "answered"; task: StoredOpenMuseTask }
  >;
  enumerateOwner(
    ownerUserId: string,
  ): Promise<Array<{ kind: "openmuse-task"; id: string }>>;
  /**
   * D02 (§9 work shutdown): the owner-scoped bulk transition behind the
   * deletion marker — the row seam's `shutdownOwnerTasks`, the report the
   * marker's bookkeeping and the T12 emit consume. Idempotent by the same
   * status guards: a repeat transitions nothing.
   */
  shutdownOwner(
    ownerUserId: string,
  ): Promise<{ cancelled: string[]; cancelRequested: string[] }>;
  /** D02 (§9): the marker check the runner's claim backstop consults. */
  ownerDisabled(ownerUserId: string): Promise<boolean>;
  /**
   * D08 (§9): the removal seam the deletion manifest's final purge calls —
   * the rows' `hardDeleteTasks`, owner-scoped and idempotent.
   */
  hardDelete(ownerUserId: string, ids: string[]): Promise<void>;
};

function newId(): string {
  return `openmuse-task-${crypto.randomUUID()}`;
}

/**
 * T16: the reply binding a document Task's carriage may carry — where the
 * reviewed reply goes after T15's fill. The S29 selection flow attaches it at
 * creation; the runner proposes exactly this as the gmail.send payload
 * (threadId/replyToMessageId are R03's binding, present or absent together).
 */
export type OpenMuseDocumentReply = {
  to: string[];
  subject: string;
  body: string;
  threadId: string;
  replyToMessageId: string;
};

/**
 * T15: a document Task's {fileId, versionId} carriage on the prompt column —
 * the same one-slot pattern a finance Task's csvFileId rides. JSON so the two
 * ids stay unambiguous however long a UUID grows. T16: an optional reply
 * binding rides the same carriage.
 */
export function documentTaskCarriage(
  fileId: string,
  versionId: string,
  reply?: OpenMuseDocumentReply,
): string {
  return JSON.stringify({
    fileId,
    versionId,
    ...(reply !== undefined ? { reply } : {}),
  });
}

/** T16: a parsed reply binding — every field present and non-empty, or null. */
function documentReplyOf(value: unknown): OpenMuseDocumentReply | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.to) ||
    record.to.length === 0 ||
    !record.to.every((to) => typeof to === "string" && to !== "") ||
    typeof record.subject !== "string" ||
    record.subject === "" ||
    typeof record.body !== "string" ||
    typeof record.threadId !== "string" ||
    record.threadId === "" ||
    typeof record.replyToMessageId !== "string" ||
    record.replyToMessageId === ""
  )
    return null;
  return {
    to: record.to,
    subject: record.subject,
    body: record.body,
    threadId: record.threadId,
    replyToMessageId: record.replyToMessageId,
  };
}

/**
 * T15: the carriage read back — null for anything that is not one. T16: a
 * present-but-malformed reply binding is a malformed carriage, never half of
 * one.
 */
export function documentTaskInput(
  prompt: string | undefined,
): { fileId: string; versionId: string; reply?: OpenMuseDocumentReply } | null {
  if (prompt === undefined) return null;
  try {
    const parsed = JSON.parse(prompt) as {
      fileId?: unknown;
      versionId?: unknown;
      reply?: unknown;
    };
    if (
      typeof parsed.fileId !== "string" ||
      typeof parsed.versionId !== "string"
    )
      return null;
    if (parsed.reply !== undefined) {
      const reply = documentReplyOf(parsed.reply);
      if (reply === null) return null;
      return { fileId: parsed.fileId, versionId: parsed.versionId, reply };
    }
    return { fileId: parsed.fileId, versionId: parsed.versionId };
  } catch {
    return null;
  }
}

/**
 * T16: the §7 review wait — `kind: "review"`, carrying the reviewed-action
 * proposal the parked reply waits on. The proposal id is the whole binding:
 * the proposal row itself holds the reply target and attachment version it
 * was created with, durably and restart-stable.
 */
export type OpenMuseReviewWait = Omit<OpenMuseTaskWait, "kind"> & {
  kind: "review";
  proposalId: string;
};

/** T16: the review wait a row carries — null for none (or a malformed one). */
export function reviewWaitOf(
  wait: OpenMuseTaskWait | undefined,
): OpenMuseReviewWait | null {
  if (wait === undefined || wait.kind !== "review") return null;
  const review = wait as OpenMuseReviewWait;
  return typeof review.proposalId === "string" ? review : null;
}

/**
 * T09: a plan's new retry attempt — succeeded steps and their evidence stay
 * (never replayed); failed or interrupted steps reset to a clean pending
 * step so the new attempt re-runs from the first one that did not complete.
 */
function resetPlanSteps(steps: unknown[]): OpenMuseTaskStep[] {
  return (steps as OpenMuseTaskStep[]).map((step) =>
    step.status === "failed" || step.status === "running"
      ? {
          id: step.id,
          title: step.title,
          dependsOn: step.dependsOn,
          status: "pending" as const,
        }
      : step,
  );
}

/**
 * T08: the §7 answer check against the wait's field definition — every field
 * present with its type, nothing unknown. A wait without a field definition
 * has no schema to break: any values object passes. Null means valid.
 */
function invalidWaitAnswer(
  fields: OpenMuseWaitField[] | undefined,
  values: Record<string, unknown>,
): string | null {
  if (typeof values !== "object" || values === null || Array.isArray(values))
    return "The answer's values must be an object.";
  if (fields === undefined) return null;
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined) return `The field "${field.name}" is required.`;
    if (field.type === "string" && typeof value !== "string")
      return `The field "${field.name}" must be text.`;
    if (field.type === "boolean" && typeof value !== "boolean")
      return `The field "${field.name}" must be true or false.`;
  }
  const known = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(values))
    if (!known.has(key))
      return `The field "${key}" is not part of this question.`;
  return null;
}

/**
 * O04's quota, enforced at the insert (round 6 M35): the create path's
 * pre-check (routes and the task_delegate tool alike) is a read, and two
 * concurrent delegates could both pass it. The drizzle rows serialize
 * count+insert per owner (an advisory transaction lock), so the bound holds
 * however many callers race; the pre-checks stay as the fast refusal path.
 */
export class OpenMuseTaskQuotaError extends Error {
  constructor() {
    super(TASK_LIMIT_MESSAGE);
    this.name = "OpenMuseTaskQuotaError";
  }
}

export function createOpenMuseTaskStore(deps: {
  rows: OpenMuseTaskRows;
  /** The shared WorkQueue a created Task is offered to (T02); absent leaves T01's create-only behaviour. */
  queue?: Pick<WorkQueue, "offer">;
  /** T10: the clock a monitor's initial nextCheckAt is computed from; the database's in production. */
  now?: () => Date;
}): OpenMuseTaskStore {
  const now = deps.now ?? (() => new Date());
  const create = async (input: {
    ownerUserId: string;
    botId: string;
    kind: OpenMuseTaskKind;
    prompt?: string;
    steps?: OpenMusePlanStepInput[];
    condition?: OpenMuseMonitorCondition;
    idempotencyKey: string | null;
  }): Promise<{ task: StoredOpenMuseTask; created: boolean }> => {
    if (await deps.rows.ownerDisabled(input.ownerUserId))
      throw new OpenMuseOwnerDisabledError(input.ownerUserId);
    if (input.idempotencyKey !== null) {
      const existing = await deps.rows.findTaskByIdempotencyKey(
        input.ownerUserId,
        input.idempotencyKey,
      );
      if (existing) return { task: existing, created: false };
    }
    const nowDate = now();
    // T10: a monitor is born `scheduled`, its first check due one interval
    // out (UTC); every other kind is `queued`, due now.
    const condition =
      input.kind === "monitor" && input.condition !== undefined
        ? input.condition
        : undefined;
    const task: StoredOpenMuseTask = {
      id: newId(),
      ownerUserId: input.ownerUserId,
      botId: input.botId,
      kind: input.kind,
      status: condition !== undefined ? "scheduled" : "queued",
      attempts: 1,
      // T09: a plan's steps ARE its graph — created pending, advanced in
      // place by the runner, never appended to.
      steps: input.steps
        ? input.steps.map((step) => ({ ...step, status: "pending" as const }))
        : [],
      evidence: [],
      artifactIds: [],
      createdAt: nowDate,
      updatedAt: nowDate,
      idempotencyKey: input.idempotencyKey,
      cancellationRequested: false,
      pauseRequested: false,
      lastRetryKey: null,
      monitorFailureStreak: 0,
      ...(condition !== undefined
        ? {
            monitorCondition: condition,
            nextCheckAt: new Date(
              nowDate.getTime() + condition.intervalMinutes * 60_000,
            ),
          }
        : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    };
    try {
      await deps.rows.insertTask(task);
    } catch (error) {
      // M35: the insert's own quota bound — one typed refusal for every
      // racing caller that passed the pre-check.
      if (error instanceof OpenMuseTaskQuotaError) throw error;
      // A concurrent insert with the same key wins; re-read and agree with it.
      if (input.idempotencyKey !== null) {
        const winner = await deps.rows.findTaskByIdempotencyKey(
          input.ownerUserId,
          input.idempotencyKey,
        );
        if (winner) return { task: winner, created: false };
      }
      throw error;
    }
    // Offered only on the row this call created: an idempotent retry hands
    // back the stored row without re-offering, and the queue's own
    // (kind, key) conflict keeps a duplicate offer from meaning two runs.
    // T10: a monitor's offer is scheduled — runAt = nextCheckAt, the
    // queue's own due gate (run_at <= now(), database clock) owns "when".
    //
    // An offer failure must PROPAGATE, not fold into the insert's catch:
    // the row exists now, so that catch would misread the failure as an
    // idempotent replay (created=false) while no queue item exists to ever
    // claim the row — a Task queued forever. An honest error beats that.
    if (deps.queue)
      await deps.queue.offer({
        kind: OPENMUSE_TASK_KIND,
        key: task.id,
        payload: { ownerUserId: task.ownerUserId },
        ...(task.nextCheckAt ? { runAt: task.nextCheckAt } : {}),
      });
    return { task, created: true };
  };

  return {
    create,
    async list(ownerUserId, page) {
      if (await deps.rows.ownerDisabled(ownerUserId))
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      const tasks = await deps.rows.listByOwner(ownerUserId, {
        limit: page.limit,
        ...(page.cursor ? { before: page.cursor } : {}),
      });
      return { tasks };
    },
    async get(ownerUserId, id) {
      const task = await deps.rows.getTask(id);
      return task && task.ownerUserId === ownerUserId ? task : null;
    },
    activeTasks: (ownerUserId) => deps.rows.countActiveByOwner(ownerUserId),
    settleTask: (id, input) =>
      deps.rows.updateTask(id, {
        ifAttempts: input.ifAttempts,
        // T04×T07, central: a cancelled row is terminal — no settle that is not
        // itself the cancellation writes over it, so a claim or terminal settle
        // whose read predated the owner's cancel cannot resurrect the work
        // (a cancelled monitor would otherwise be re-armed scheduled forever).
        ...(input.status === "cancelled"
          ? { ...(input.ifStatus ? { ifStatus: input.ifStatus } : {}) }
          : { ifStatus: input.ifStatus ?? NOT_CANCELLED }),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
        ...(input.setSteps ? { steps: input.setSteps } : {}),
        ...(input.setEvidence ? { evidence: input.setEvidence } : {}),
        ...(input.appendedSteps ? { appendedSteps: input.appendedSteps } : {}),
        ...(input.appendedEvidence
          ? { appendedEvidence: input.appendedEvidence }
          : {}),
        ...(input.appendedArtifactIds
          ? { appendedArtifactIds: input.appendedArtifactIds }
          : {}),
        ...(input.nextCheckAt ? { nextCheckAt: input.nextCheckAt } : {}),
        // T11: !== undefined, not truthiness — a zero streak must land.
        ...(input.monitorFailureStreak !== undefined
          ? { monitorFailureStreak: input.monitorFailureStreak }
          : {}),
        ...(input.lastObservationHash !== undefined
          ? { lastObservationHash: input.lastObservationHash }
          : {}),
        ...(input.lastObservationAt !== undefined
          ? { lastObservationAt: input.lastObservationAt }
          : {}),
      }),
    disableOwner: (ownerUserId) => deps.rows.disableOwner(ownerUserId),
    restoreOwner: (ownerUserId) => deps.rows.restoreOwner(ownerUserId),
    async requestCancel(ownerUserId, id) {
      if (await deps.rows.ownerDisabled(ownerUserId))
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      // Owner scope first, as get(): a foreign row is indistinguishable from
      // a missing one, so no cancel side effect can leak across owners.
      const current = await deps.rows.getTask(id);
      if (!current || current.ownerUserId !== ownerUserId)
        return { outcome: "missing" } as const;
      const cas = await deps.rows.requestTaskCancel(id);
      if (cas.kind === "missing") return { outcome: "missing" } as const;
      if (cas.kind === "applied")
        return cas.task.status === "cancelled"
          ? { outcome: "cancelled", task: cas.task }
          : { outcome: "requested", task: cas.task };
      // Unapplied: an idempotent re-request on a flagged running row answers
      // the same way; every other state the matrix refuses is terminal.
      return cas.task.status === "running" && cas.task.cancellationRequested
        ? { outcome: "requested", task: cas.task }
        : { outcome: "terminal", task: cas.task };
    },
    async requestPause(ownerUserId, id) {
      if (await deps.rows.ownerDisabled(ownerUserId))
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      // Owner scope first, as get(): a foreign row is indistinguishable from
      // a missing one, so no pause side effect can leak across owners.
      const current = await deps.rows.getTask(id);
      if (!current || current.ownerUserId !== ownerUserId)
        return { outcome: "missing" } as const;
      const cas = await deps.rows.requestTaskPause(id);
      if (cas.kind === "missing") return { outcome: "missing" } as const;
      if (cas.kind === "applied")
        return cas.task.status === "paused"
          ? { outcome: "paused", task: cas.task }
          : { outcome: "requested", task: cas.task };
      // Unapplied: an idempotent re-request on a flagged running row answers
      // the same way; every other state the matrix refuses is terminal.
      return cas.task.status === "running" && cas.task.pauseRequested
        ? { outcome: "requested", task: cas.task }
        : { outcome: "terminal", task: cas.task };
    },
    async resumeTask(ownerUserId, id) {
      if (await deps.rows.ownerDisabled(ownerUserId))
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      // Owner scope first, as get(): a foreign row is indistinguishable from
      // a missing one, so no re-offer can leak across owners.
      const current = await deps.rows.getTask(id);
      if (!current || current.ownerUserId !== ownerUserId)
        return { outcome: "missing" } as const;
      const cas = await deps.rows.resumeTask(id);
      if (cas.kind === "missing") return { outcome: "missing" } as const;
      if (cas.kind === "unapplied")
        return { outcome: "terminal", task: cas.task } as const;
      // The applied CAS is the status guard: only the one pause→queued swap
      // re-offers, so a double resume can never enqueue a second run. The
      // re-offer is its own piece of work under a fresh key — a queue key is
      // a one-shot identity, and the row that carried `task.id` was finished
      // (claimed, skipped while paused, or paused mid-run); re-offering it
      // would collide with that finished row and be silently swallowed.
      // `taskId` rides in the payload because the key no longer is the id.
      // T10: a monitor's re-offer is scheduled at the re-armed nextCheckAt
      // the CAS computed — due one interval out, not now.
      if (deps.queue)
        await deps.queue.offer({
          kind: OPENMUSE_TASK_KIND,
          key: `${cas.task.id}:${crypto.randomUUID()}`,
          payload: {
            ownerUserId: cas.task.ownerUserId,
            taskId: cas.task.id,
          },
          ...(cas.task.kind === "monitor" && cas.task.nextCheckAt
            ? { runAt: cas.task.nextCheckAt }
            : {}),
        });
      return { outcome: "resumed", task: cas.task };
    },
    async retryTask(ownerUserId, id, retryKey) {
      if (await deps.rows.ownerDisabled(ownerUserId))
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      // Owner scope first, as get(): a foreign row is indistinguishable
      // from a missing one, so no re-offer can leak across owners.
      const current = await deps.rows.getTask(id);
      if (!current || current.ownerUserId !== ownerUserId)
        return { outcome: "missing" } as const;
      // T09: a plan's retry resets what did not complete in the same atomic
      // swap — computed from the row just read, safe because only a failed
      // row passes the CAS below and nothing else rewrites a failed row.
      const cas = await deps.rows.retryTask(
        id,
        retryKey,
        current.kind === "plan" ? resetPlanSteps(current.steps) : undefined,
      );
      if (cas.kind === "missing") return { outcome: "missing" } as const;
      if (cas.kind === "replayed")
        return { outcome: "replayed", task: cas.task } as const;
      if (cas.kind === "unapplied")
        return { outcome: "terminal", task: cas.task } as const;
      // The applied CAS is the status guard: only the one failed→queued swap
      // re-offers, so a replayed key never enqueues a second run. Fresh
      // queue identity as resume — the queue row that carried `task.id` was
      // finished by the failed attempt's claim. T06×T10: a monitor's
      // re-offer is scheduled at the re-armed nextCheckAt the CAS computed
      // (now, for a retry), exactly as resume's is.
      if (deps.queue)
        await deps.queue.offer({
          kind: OPENMUSE_TASK_KIND,
          key: `${cas.task.id}:${crypto.randomUUID()}`,
          payload: {
            ownerUserId: cas.task.ownerUserId,
            taskId: cas.task.id,
          },
          ...(cas.task.kind === "monitor" && cas.task.nextCheckAt
            ? { runAt: cas.task.nextCheckAt }
            : {}),
        });
      return { outcome: "retried", task: cas.task };
    },
    openWait: (taskId, input) => {
      // One fresh waitId per open, so two waits on one task are never
      // confused, and the answer names the exact wait it answers.
      const wait: OpenMuseTaskWait = {
        waitId: `openmuse-wait-${crypto.randomUUID()}`,
        taskId,
        kind: "input",
        question: input.question,
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        createdAt: new Date().toISOString(),
      };
      return deps.rows.openTaskWait(taskId, {
        wait,
        ifAttempts: input.ifAttempts,
        ...(input.appendedSteps ? { appendedSteps: input.appendedSteps } : {}),
        ...(input.appendedEvidence
          ? { appendedEvidence: input.appendedEvidence }
          : {}),
      });
    },
    openReviewWait: (taskId, input) => {
      // The review wait's one binding is the proposal id — fresh waitId as
      // every wait, so a re-proposed reply is a different wait, never confused.
      const wait: OpenMuseReviewWait = {
        waitId: `openmuse-wait-${crypto.randomUUID()}`,
        taskId,
        kind: "review",
        question: input.question,
        proposalId: input.proposalId,
        createdAt: new Date().toISOString(),
      };
      return deps.rows.openTaskReviewWait(taskId, {
        wait,
        ifAttempts: input.ifAttempts,
        ...(input.appendedSteps ? { appendedSteps: input.appendedSteps } : {}),
        ...(input.appendedEvidence
          ? { appendedEvidence: input.appendedEvidence }
          : {}),
        ...(input.appendedArtifactIds
          ? { appendedArtifactIds: input.appendedArtifactIds }
          : {}),
      });
    },
    async answerWait(ownerUserId, id, waitId, values) {
      if (await deps.rows.ownerDisabled(ownerUserId))
        throw new OpenMuseOwnerDisabledError(ownerUserId);
      // Owner scope first, as every control path: a foreign row is
      // indistinguishable from a missing one, so no answer leaks across owners.
      const current = await deps.rows.getTask(id);
      if (!current || current.ownerUserId !== ownerUserId)
        return { outcome: "missing" } as const;
      const wait = current.wait;
      // The exact waitId is the answer's address: a wrong one is missing.
      if (!wait || wait.waitId !== waitId)
        return { outcome: "missing" } as const;
      // A consumed wait always replays its stored result — even a malformed
      // repeat, because the answer already happened and cannot advance twice.
      if (wait.answeredAt !== undefined)
        return { outcome: "replayed", task: current } as const;
      // Validate BEFORE any write: a malformed answer leaves the wait open.
      const invalid = invalidWaitAnswer(wait.fields, values);
      if (invalid) return { outcome: "invalid", error: invalid } as const;
      // invalidWaitAnswer proved every value matches its field's type.
      const answer = values as Record<string, string | boolean>;
      const cas = await deps.rows.answerTaskWait(id, waitId, answer);
      if (cas.kind === "missing") return { outcome: "missing" } as const;
      if (cas.kind === "replayed")
        return { outcome: "replayed", task: cas.task } as const;
      if (cas.kind === "unapplied")
        return { outcome: "terminal", task: cas.task } as const;
      // The consumed CAS is the status guard: only the one consume re-offers,
      // under a fresh queue identity exactly as resume and retry do.
      if (deps.queue)
        await deps.queue.offer({
          kind: OPENMUSE_TASK_KIND,
          key: `${cas.task.id}:${crypto.randomUUID()}`,
          payload: {
            ownerUserId: cas.task.ownerUserId,
            taskId: cas.task.id,
          },
        });
      return { outcome: "answered", task: cas.task } as const;
    },
    async enumerateOwner(ownerUserId) {
      return (await deps.rows.listIdsByOwner(ownerUserId)).map((id) => ({
        kind: OPENMUSE_TASK_KIND,
        id,
      }));
    },
    shutdownOwner: (ownerUserId) => deps.rows.shutdownOwnerTasks(ownerUserId),
    hardDelete: (ownerUserId, ids) =>
      deps.rows.hardDeleteTasks(ownerUserId, ids),
    ownerDisabled: (ownerUserId) => deps.rows.ownerDisabled(ownerUserId),
  };
}

function rowToTask(row: OpenMuseTaskRow): StoredOpenMuseTask {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    botId: row.botId,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    steps: row.steps ?? [],
    evidence: row.evidence ?? [],
    artifactIds: row.artifactIds ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    idempotencyKey: row.idempotencyKey,
    cancellationRequested: row.cancellationRequested,
    pauseRequested: row.pauseRequested,
    lastRetryKey: row.lastRetryKey,
    ...(row.wait ? { wait: row.wait } : {}),
    ...(row.monitorCondition ? { monitorCondition: row.monitorCondition } : {}),
    ...(row.nextCheckAt ? { nextCheckAt: row.nextCheckAt } : {}),
    ...(row.lastObservationHash
      ? { lastObservationHash: row.lastObservationHash }
      : {}),
    ...(row.lastObservationAt
      ? { lastObservationAt: row.lastObservationAt }
      : {}),
    monitorFailureStreak: row.monitorFailureStreak,
    prompt: row.prompt,
  };
}

/** The drizzle-backed row seam. */
export function createOpenMuseTaskRows(database: Database): OpenMuseTaskRows {
  const ownerDisabledRow = createOwnerDisabled(database);
  return {
    async insertTask(task) {
      /*
       * M35: the quota bound lives HERE, inside one transaction per owner.
       * The per-owner advisory transaction lock serializes count+insert, so
       * two racing creates cannot both pass a full quota — the check-then-
       * insert window the routes' and the tool's pre-checks could never
       * close. An idempotent replay never reaches this method (the store's
       * create answers it from the row), so the bound cannot refuse a
       * legitimate retry.
       */
      await database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${task.ownerUserId}, 0))`,
        );
        const [counted] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(openmuseTasks)
          .where(
            and(
              eq(openmuseTasks.ownerUserId, task.ownerUserId),
              notInArray(openmuseTasks.status, [
                "succeeded",
                "failed",
                "cancelled",
              ]),
            ),
          );
        if ((counted?.count ?? 0) >= ACTIVE_TASKS_PER_USER) {
          throw new OpenMuseTaskQuotaError();
        }
        await tx.insert(openmuseTasks).values({
          id: task.id,
          ownerUserId: task.ownerUserId,
          botId: task.botId,
          kind: task.kind,
          prompt: task.prompt ?? "",
          status: task.status,
          attempts: task.attempts,
          steps: task.steps,
          evidence: task.evidence,
          artifactIds: task.artifactIds,
          cancellationRequested: task.cancellationRequested,
          pauseRequested: task.pauseRequested,
          lastRetryKey: task.lastRetryKey,
          wait: task.wait ?? null,
          monitorCondition: task.monitorCondition ?? null,
          nextCheckAt: task.nextCheckAt ?? null,
          lastObservationHash: task.lastObservationHash ?? null,
          lastObservationAt: task.lastObservationAt ?? null,
          monitorFailureStreak: task.monitorFailureStreak,
          idempotencyKey: task.idempotencyKey,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
      });
    },
    async findTaskByIdempotencyKey(ownerUserId, key) {
      const [row] = await database
        .select()
        .from(openmuseTasks)
        .where(
          and(
            eq(openmuseTasks.ownerUserId, ownerUserId),
            eq(openmuseTasks.idempotencyKey, key),
          ),
        )
        .limit(1);
      return row ? rowToTask(row) : null;
    },
    async getTask(id) {
      const [row] = await database
        .select()
        .from(openmuseTasks)
        .where(eq(openmuseTasks.id, id))
        .limit(1);
      return row ? rowToTask(row) : null;
    },
    async listByOwner(ownerUserId, page) {
      const conditions = [eq(openmuseTasks.ownerUserId, ownerUserId)];
      if (page.before) {
        // Keyset cursor pushed into the SQL, matching the in-memory seam's
        // order exactly — createdAt desc, id desc — so rows sharing the
        // cursor's createdAt are still reachable by the id tiebreak instead
        // of silently skipped. (A strict createdAt-only comparison drops
        // same-millisecond rows created before the cursor's id.)
        const tiebreak = or(
          lt(openmuseTasks.createdAt, page.before.createdAt),
          and(
            eq(openmuseTasks.createdAt, page.before.createdAt),
            lt(openmuseTasks.id, page.before.id),
          ),
        );
        if (tiebreak) conditions.push(tiebreak);
      }
      const rows = await database
        .select()
        .from(openmuseTasks)
        .where(and(...conditions))
        .orderBy(desc(openmuseTasks.createdAt), desc(openmuseTasks.id))
        .limit(page.limit);
      return rows.map(rowToTask);
    },
    async listIdsByOwner(ownerUserId) {
      const rows = await database
        .select({ id: openmuseTasks.id })
        .from(openmuseTasks)
        .where(eq(openmuseTasks.ownerUserId, ownerUserId));
      return rows.map((row) => row.id);
    },
    async countActiveByOwner(ownerUserId) {
      const [row] = await database
        .select({ count: sql<number>`count(*)::int` })
        .from(openmuseTasks)
        .where(
          and(
            eq(openmuseTasks.ownerUserId, ownerUserId),
            notInArray(openmuseTasks.status, [
              "succeeded",
              "failed",
              "cancelled",
            ]),
          ),
        );
      return row?.count ?? 0;
    },
    async hardDeleteTasks(ownerUserId, ids) {
      if (ids.length === 0) return;
      await database
        .delete(openmuseTasks)
        .where(
          and(
            eq(openmuseTasks.ownerUserId, ownerUserId),
            inArray(openmuseTasks.id, ids),
          ),
        );
    },
    async updateTask(id, patch) {
      /*
       * Absolute jsonb replacement and jsonb append are mutually exclusive:
       * sent together, the later spread arm below silently wins and the
       * caller believes it replaced the column. Refuse instead — every
       * current caller sends exactly one of the pair.
       */
      if (patch.steps && patch.appendedSteps)
        throw new Error("steps and appendedSteps are mutually exclusive.");
      if (patch.evidence && patch.appendedEvidence)
        throw new Error(
          "evidence and appendedEvidence are mutually exclusive.",
        );
      const [row] = await database
        .update(openmuseTasks)
        .set({
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
          ...(patch.nextCheckAt ? { nextCheckAt: patch.nextCheckAt } : {}),
          // T11: !== undefined, not truthiness — a zero streak must land.
          ...(patch.lastObservationHash !== undefined
            ? { lastObservationHash: patch.lastObservationHash }
            : {}),
          ...(patch.lastObservationAt !== undefined
            ? { lastObservationAt: patch.lastObservationAt }
            : {}),
          ...(patch.monitorFailureStreak !== undefined
            ? { monitorFailureStreak: patch.monitorFailureStreak }
            : {}),
          // T09: a plan's graph is replaced whole — one step's status moves,
          // never an append onto the graph the runner selects from.
          ...(patch.steps
            ? { steps: sql`${JSON.stringify(patch.steps)}::jsonb` }
            : {}),
          ...(patch.appendedSteps
            ? {
                steps: sql`${openmuseTasks.steps} || ${JSON.stringify(patch.appendedSteps)}::jsonb`,
              }
            : {}),
          // T11: a monitor's evidence is replaced whole — the capped latest
          // rows — so a drifting source's observations cannot grow the jsonb
          // column without bound.
          ...(patch.evidence
            ? { evidence: sql`${JSON.stringify(patch.evidence)}::jsonb` }
            : {}),
          ...(patch.appendedEvidence
            ? {
                evidence: sql`${openmuseTasks.evidence} || ${JSON.stringify(patch.appendedEvidence)}::jsonb`,
              }
            : {}),
          ...(patch.appendedArtifactIds
            ? {
                artifactIds: sql`${openmuseTasks.artifactIds} || ${JSON.stringify(patch.appendedArtifactIds)}::jsonb`,
              }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(openmuseTasks.id, id),
            // T07: the attempts count is the claim's generation; a sweep
            // whose generation has been recovered writes nothing.
            ...(patch.ifAttempts !== undefined
              ? [eq(openmuseTasks.attempts, patch.ifAttempts)]
              : []),
            // T04×T07: the statuses the caller's read saw — a cancel/pause CAS
            // that landed in the read-then-write window moved the row somewhere
            // else without touching attempts, and must not be overwritten.
            ...(patch.ifStatus
              ? [inArray(openmuseTasks.status, patch.ifStatus)]
              : []),
          ),
        )
        .returning();
      return row ? rowToTask(row) : null;
    },
    /*
     * D02: the marker check the deletion fence is (§9) — phase-aware the way
     * the /api/mobile fence reads it: the owner is disabled while the marker
     * is still `fenced`, and D05's restore lifts it, so a restored account's
     * Task surface answers instead of refusing forever.
     */
    ownerDisabled: ownerDisabledRow,
    async disableOwner() {},
    async restoreOwner() {},
    async requestTaskCancel(id): Promise<TaskCancelCas> {
      /*
       * One statement, one row: the WHERE guard is the matrix, the CASEs are
       * the two transitions, RETURNING proves the swap happened.
       *
       * Round 6 (M43) folded waiting_input/waiting_review into the matrix —
       * the same rows shutdownOwnerTasks already cancels (its RECORDED
       * DIVERGENCE, now reconciled in the cancel direction): a waiting row
       * counts against ACTIVE_TASKS_PER_USER, and the runner stops polling a
       * waiting row whose provider turn ended ambiguous — without a cancel
       * path the owner could never abandon it and the slot was held
       * indefinitely. The wait record itself stays on the row as the record
       * of what was abandoned.
       */
      const [row] = await database
        .update(openmuseTasks)
        .set({
          status: sql`CASE WHEN ${openmuseTasks.status} IN ('queued', 'scheduled', 'paused', 'waiting_input', 'waiting_review') THEN 'cancelled' ELSE ${openmuseTasks.status} END`,
          cancellationRequested: sql`CASE WHEN ${openmuseTasks.status} = 'running' THEN true ELSE ${openmuseTasks.cancellationRequested} END`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(openmuseTasks.id, id),
            or(
              inArray(openmuseTasks.status, [
                "queued",
                "scheduled",
                "paused",
                "waiting_input",
                "waiting_review",
              ]),
              and(
                eq(openmuseTasks.status, "running"),
                eq(openmuseTasks.cancellationRequested, false),
              ),
            ),
          ),
        )
        .returning();
      return casOutcome(database, id, row);
    },
    async requestTaskPause(id): Promise<TaskControlCas> {
      // Same shape as the cancel CAS, one transition pair: queued/scheduled
      // land paused now, running only raises the internal flag.
      const [row] = await database
        .update(openmuseTasks)
        .set({
          status: sql`CASE WHEN ${openmuseTasks.status} IN ('queued', 'scheduled') THEN 'paused' ELSE ${openmuseTasks.status} END`,
          pauseRequested: sql`CASE WHEN ${openmuseTasks.status} = 'running' THEN true ELSE ${openmuseTasks.pauseRequested} END`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(openmuseTasks.id, id),
            or(
              inArray(openmuseTasks.status, ["queued", "scheduled"]),
              and(
                eq(openmuseTasks.status, "running"),
                eq(openmuseTasks.pauseRequested, false),
              ),
            ),
          ),
        )
        .returning();
      return casOutcome(database, id, row);
    },
    async resumeTask(id): Promise<TaskControlCas> {
      // The single legal transition; it doubles as the exactly-once guard on
      // the re-offer the store makes when it sees `applied`. T10: a monitor
      // resumes `scheduled`, re-armed now+interval from its own condition —
      // computed in SQL so the re-arm and the queue's runAt read one clock,
      // the database's.
      const [row] = await database
        .update(openmuseTasks)
        .set({
          status: sql`CASE WHEN ${openmuseTasks.kind} = 'monitor' THEN 'scheduled' ELSE 'queued' END`,
          pauseRequested: false,
          nextCheckAt: sql`CASE WHEN ${openmuseTasks.kind} = 'monitor' THEN now() + make_interval(mins => (${openmuseTasks.monitorCondition} ->> 'intervalMinutes')::int) ELSE ${openmuseTasks.nextCheckAt} END`,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(openmuseTasks.id, id), eq(openmuseTasks.status, "paused")),
        )
        .returning();
      return casOutcome(database, id, row);
    },
    async retryTask(id, retryKey, resetSteps): Promise<TaskRetryCas> {
      // One statement, one row: the WHERE guard is the matrix — failed only,
      // and a retry key the row already recorded is refused — the SET is the
      // new attempt (attempts+1, flags cleared, every old step and evidence
      // row retained — except a plan's reset steps, which land in the same
      // swap). Retained rows are stamped with the generation that wrote them
      // (the SET expressions read the OLD attempts, one below the bump), so
      // T07's recovery can tell retained history from the retry's own rows.
      // A monitor retries to `scheduled` re-armed now: the runner's monitor
      // branch only executes scheduled rows, so a monitor parked in `queued`
      // by a retry would never check again — the re-offer the store layer
      // makes below carries the same re-armed instant as its runAt.
      const stampAttempt = (column: SQLWrapper) => sql`(
        select coalesce(
          jsonb_agg(element || jsonb_build_object('attempt', ${openmuseTasks.attempts})),
          '[]'::jsonb
        )
        from jsonb_array_elements(${column}) as element
      )`;
      const [row] = await database
        .update(openmuseTasks)
        .set({
          status: sql`CASE WHEN ${openmuseTasks.kind} = 'monitor' THEN 'scheduled' ELSE 'queued' END`,
          nextCheckAt: sql`CASE WHEN ${openmuseTasks.kind} = 'monitor' THEN now() ELSE ${openmuseTasks.nextCheckAt} END`,
          attempts: sql`${openmuseTasks.attempts} + 1`,
          cancellationRequested: false,
          pauseRequested: false,
          ...(retryKey !== null ? { lastRetryKey: retryKey } : {}),
          steps: resetSteps
            ? stampAttempt(sql`${JSON.stringify(resetSteps)}::jsonb`)
            : stampAttempt(openmuseTasks.steps),
          evidence: stampAttempt(openmuseTasks.evidence),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(openmuseTasks.id, id),
            eq(openmuseTasks.status, "failed"),
            // Once per key: a consumed key never double-applies, concurrent
            // or sequential; a keyless retry has no key to guard.
            ...(retryKey !== null
              ? [
                  sql`${openmuseTasks.lastRetryKey} is distinct from ${retryKey}`,
                ]
              : []),
          ),
        )
        .returning();
      if (row) return { kind: "applied", task: rowToTask(row) };
      const [current] = await database
        .select()
        .from(openmuseTasks)
        .where(eq(openmuseTasks.id, id))
        .limit(1);
      if (!current) return { kind: "missing" };
      return retryKey !== null && current.lastRetryKey === retryKey
        ? { kind: "replayed", task: rowToTask(current) }
        : { kind: "unapplied", task: rowToTask(current) };
    },
    async openTaskWait(id, patch) {
      // One statement, one row: running only, generation-guarded — a stale
      // sweep cannot park a Task the recovery already owns.
      const [row] = await database
        .update(openmuseTasks)
        .set({
          status: "waiting_input",
          wait: patch.wait,
          ...(patch.appendedSteps
            ? {
                steps: sql`${openmuseTasks.steps} || ${JSON.stringify(patch.appendedSteps)}::jsonb`,
              }
            : {}),
          ...(patch.appendedEvidence
            ? {
                evidence: sql`${openmuseTasks.evidence} || ${JSON.stringify(patch.appendedEvidence)}::jsonb`,
              }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(openmuseTasks.id, id),
            eq(openmuseTasks.status, "running"),
            eq(openmuseTasks.attempts, patch.ifAttempts),
          ),
        )
        .returning();
      return row ? rowToTask(row) : null;
    },
    async openTaskReviewWait(id, patch) {
      // T16: openTaskWait's shape, parking `waiting_review` — the review wait
      // is §7's second kind on the same jsonb column, and the derived
      // version's artifact link lands in the same guarded write.
      const [row] = await database
        .update(openmuseTasks)
        .set({
          status: "waiting_review",
          wait: patch.wait,
          ...(patch.appendedSteps
            ? {
                steps: sql`${openmuseTasks.steps} || ${JSON.stringify(patch.appendedSteps)}::jsonb`,
              }
            : {}),
          ...(patch.appendedEvidence
            ? {
                evidence: sql`${openmuseTasks.evidence} || ${JSON.stringify(patch.appendedEvidence)}::jsonb`,
              }
            : {}),
          ...(patch.appendedArtifactIds
            ? {
                artifactIds: sql`${openmuseTasks.artifactIds} || ${JSON.stringify(patch.appendedArtifactIds)}::jsonb`,
              }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(openmuseTasks.id, id),
            eq(openmuseTasks.status, "running"),
            eq(openmuseTasks.attempts, patch.ifAttempts),
          ),
        )
        .returning();
      return row ? rowToTask(row) : null;
    },
    async answerTaskWait(id, waitId, answer): Promise<TaskWaitAnswerCas> {
      // One statement, one row: the WHERE guard is the consume — this wait,
      // still open, on a row still waiting — and the SET is the atomic
      // consume: answeredAt and the stored answer beside the queued swap.
      const [row] = await database
        .update(openmuseTasks)
        .set({
          status: "queued",
          wait: sql`jsonb_set(jsonb_set(${openmuseTasks.wait}, '{answeredAt}', to_jsonb(now())), '{answer}', ${JSON.stringify(answer)}::jsonb)`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(openmuseTasks.id, id),
            eq(openmuseTasks.status, "waiting_input"),
            sql`${openmuseTasks.wait} ->> 'waitId' = ${waitId}`,
            sql`${openmuseTasks.wait} ->> 'answeredAt' is null`,
          ),
        )
        .returning();
      if (row) return { kind: "consumed", task: rowToTask(row) };
      // No swap: read the row back and say why — another answer won the race
      // (replayed), the status moved on (unapplied), or no such wait.
      const [current] = await database
        .select()
        .from(openmuseTasks)
        .where(eq(openmuseTasks.id, id))
        .limit(1);
      if (!current?.wait || current.wait.waitId !== waitId)
        return { kind: "missing" };
      return current.wait.answeredAt !== undefined
        ? { kind: "replayed", task: rowToTask(current) }
        : { kind: "unapplied", task: rowToTask(current) };
    },
    async shutdownOwnerTasks(ownerUserId) {
      /*
       * Two guarded writes, never a blind UPDATE ALL: each WHERE is the same
       * status guard the per-row CAS helpers carry, so the bulk transition is
       * the matrix applied at once, not a state machine bypassed.
       *
       * DIVERGENCE RECONCILED (round 6 M43): waiting_input/waiting_review
       * now cancel through the per-row requestTaskCancel matrix too, the
       * same direction this bulk list always took (pause still refuses them
       * — a paused wait has no resume path that restores the wait). The
       * certification review ruled on the recorded split: a waiting row
       * holds an ACTIVE_TASKS_PER_USER slot and the runner never re-polls
       * one that parked ambiguous, so the owner needs the exit.
       */
      const cancelled = await database
        .update(openmuseTasks)
        .set({ status: "cancelled", updatedAt: sql`now()` })
        .where(
          and(
            eq(openmuseTasks.ownerUserId, ownerUserId),
            inArray(openmuseTasks.status, [
              "queued",
              "scheduled",
              "paused",
              "waiting_input",
              "waiting_review",
            ]),
          ),
        )
        .returning({ id: openmuseTasks.id });
      const cancelRequested = await database
        .update(openmuseTasks)
        .set({ cancellationRequested: true, updatedAt: sql`now()` })
        .where(
          and(
            eq(openmuseTasks.ownerUserId, ownerUserId),
            eq(openmuseTasks.status, "running"),
            eq(openmuseTasks.cancellationRequested, false),
          ),
        )
        .returning({ id: openmuseTasks.id });
      return {
        cancelled: cancelled.map((row) => row.id),
        cancelRequested: cancelRequested.map((row) => row.id),
      };
    },
  };
}

/** The tail every control CAS shares: prove the swap, or read the row back to say why it refused. */
async function casOutcome(
  database: Database,
  id: string,
  row: OpenMuseTaskRow | undefined,
): Promise<TaskControlCas> {
  if (row) return { kind: "applied", task: rowToTask(row) };
  const [current] = await database
    .select()
    .from(openmuseTasks)
    .where(eq(openmuseTasks.id, id))
    .limit(1);
  return current
    ? { kind: "unapplied", task: rowToTask(current) }
    : { kind: "missing" };
}
