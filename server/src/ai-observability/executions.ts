/**
 * Isolated execution of evaluation experiments (Issue #29 / DAG T23).
 *
 * An execution runs a FROZEN experiment, never a draft: the store refuses to
 * enqueue against anything but a frozen row, the row carries the config hash
 * it froze at enqueue, and the worker re-checks both before a single case
 * runs. The frozen configuration drives everything the execution may do,
 * including the read-only tool whitelist it was submitted with.
 *
 * Isolation is structural, not behavioral. The only handle a case receives
 * is its frozen case, the frozen configuration, and `callTool` — the one
 * seam through which a tool call passes, and the place every production
 * write is refused. There is no session handle, no memory handle, no
 * billing or channel surface in the case context at all: a case cannot
 * reach the production world because nothing that could reach it is in
 * scope. `callTool` never executes a live tool either — a whitelisted,
 * classifier-confirmed read-only call is answered by replaying the frozen
 * fixture, so the evaluation has no real side-effect channel even for
 * reads.
 *
 * The gate's decision order is fail-closed three times over. A name the
 * frozen whitelist never listed is refused — unknown tools land here, so
 * "the model invented a tool" is a refusal, not a silent skip. A
 * whitelisted name the production classifier still calls a write is
 * refused — the whitelist may narrow what an evaluation may call, never
 * widen it, the same direction `classifyTool` already holds for grants.
 * A whitelisted read with no frozen fixture is refused — there is nothing
 * honest to answer with. Every refusal is counted on the execution row and
 * carried into the audit trail at settle: the governance channel sees how
 * often the evaluation reached for the world and was stopped.
 *
 * The runner is the T34 export worker's lease pattern on a new kind: a
 * claim ticket on the shared work queue, re-authorization from LIVE
 * ownership before anything runs — per case, so a revocation stops the
 * run at the next case boundary — conditional settles that a revocation
 * can always win, and a state vocabulary the database enforces. Each
 * case is marked in a durable write-ahead row before its invocation and
 * its outcome lands in one conditional flip, so a restart or lease
 * takeover resumes without re-running a completed sample and never
 * re-invokes one whose outcome it could not observe.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SafeText, SafeValue } from "../../../shared/ai-observability";
import { getLogger } from "../../../shared/logger";
import { workOwner } from "../../../shared/work-owner";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { aiObservationDatasetVersions } from "../db/schema/ai-observability-datasets";
import { aiObservationExecutionCaseOutcomes } from "../db/schema/ai-observability-execution-case-outcomes";
import {
  type AiObservationExecutionState,
  aiObservationExperimentExecutions,
} from "../db/schema/ai-observability-executions";
import { aiObservationExperiments } from "../db/schema/ai-observability-experiments";
import { workItems } from "../db/schema/work";
import { type Repeating, repeatAfterEach } from "../work/loop";
import { createWorkQueue, type WorkQueue } from "../work/queue";
import type { ObservationScope } from "./contracts";
import type { FrozenDatasetCase } from "./datasets";
import type { FrozenExperimentConfig } from "./experiments";
import {
  projectSafeFixture,
  projectSafeName,
  projectSafeText,
} from "./redaction";
import { assertObservationScope } from "./scope";

/** The work-queue kind an execution's claim ticket rides on. */
export const EXECUTION_WORK_KIND = "opik.experiment_execution";

export type ExecutionState = AiObservationExecutionState;

const EXECUTION_STATES: ReadonlySet<string> = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * A stored state onto the vocabulary, fail closed: a value the database check should have
 * refused is a defect to surface, never a state to echo or guess. The export vocabulary's
 * `queued` is deliberately absent — this slice's first word is `pending`.
 */
export function parseExecutionState(value: unknown): ExecutionState {
  if (typeof value === "string" && EXECUTION_STATES.has(value)) {
    return value as ExecutionState;
  }
  throw new ExecutionError("EXECUTION_STATE_INVALID", 500);
}

/** Whether a state is one the execution cannot leave. */
export function isTerminalExecutionState(state: ExecutionState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/** The codes a settled-failed execution may carry. The code is the contract. */
export const EXECUTION_JOB_ERROR_CODES = [
  /** The experiment is not a frozen one — a draft, a drifted hash, or a row that vanished. */
  "EXPERIMENT_NOT_FROZEN",
  /** The pinned dataset version is gone (only the future retention path could do that). */
  "DATASET_VERSION_MISSING",
  /** The case runner itself failed before any outcome could be recorded honestly. */
  "CASE_EXECUTION_ERROR",
] as const;

export type ExecutionJobErrorCode = (typeof EXECUTION_JOB_ERROR_CODES)[number];

export type ExecutionErrorCode =
  | "EXECUTION_INPUT_INVALID"
  | "EXECUTION_EXPERIMENT_NOT_FOUND"
  | "EXECUTION_EXPERIMENT_NOT_FROZEN"
  | "EXECUTION_BUDGET_REFUSED"
  | "EXECUTION_STATE_INVALID";

export class ExecutionError extends Error {
  constructor(
    public code: ExecutionErrorCode,
    public status: 400 | 402 | 404 | 409 | 500,
  ) {
    super(code);
  }
}

/** How honestly one case ended. `unknown` is an ending the runner could not observe. */
export type EvaluationCaseStatus = "completed" | "failed" | "unknown";

/** What the case runner answers for one case: a status, and optionally why. */
export type EvaluationCaseOutcome = Readonly<{
  status: EvaluationCaseStatus;
  /**
   * The case's model output — text or structured, raw as the runner observed it.
   * The settle projects it before anything lands (T28's result contract): raw free
   * text never reaches the result column, at any depth.
   */
  output?: unknown;
  /** The case's usage record (tokens and friends), raw as the runner observed it. */
  usage?: unknown;
  /**
   * The case's judge record (T27), when a judge wrapper ran and answered. A scoring
   * fact beside the execution facts — the judge's own score, rationale and usage —
   * projected with its own budget on the way in, exactly like output and usage.
   */
  judge?: unknown;
}>;

/** Why a tool call was refused in the evaluation context. */
export type ToolRefusalReason = "not_whitelisted" | "write_tool" | "no_fixture";

/**
 * The one answer a tool call in the evaluation context gets: a replayed frozen
 * fixture, or a refusal with its reason. Never a live execution.
 */
export type EvaluationToolCall =
  | { outcome: "replayed"; fixture: unknown }
  | { outcome: "refused"; reason: ToolRefusalReason };

/**
 * Whether a tool name reads or writes in production terms. The wiring builds this over
 * the plugin catalogue's `classifyTool` — the reviewed-list answer that may narrow a
 * Bot's reach and never widen it. Here it is a seam, so the gate's contract is testable
 * without the catalogue behind it.
 */
export type EvaluationToolClassifier = (toolName: string) => "read" | "write";

/** How many calls the gate refused, and the distinct tools it refused them for. */
export type ToolGateTally = Readonly<{
  rejections: number;
  rejectedTools: readonly string[];
}>;

export type EvaluationToolGate = Readonly<{
  /**
   * Decide one tool call under the frozen configuration. `fixtures` is the lookup order:
   * the case's own frozen fixtures first, the experiment configuration's second.
   */
  call: (
    toolName: string,
    fixtures: readonly SafeValue[],
  ) => EvaluationToolCall;
  /** The governance tally so far: every refusal counted, distinct names only. */
  tally: () => ToolGateTally;
}>;

/**
 * The unified interception point. One gate per execution; every tool call every case
 * makes passes through `call`, so no tool is patched individually and none can skip.
 */
export function createEvaluationToolGate(
  config: FrozenExperimentConfig,
  classify: EvaluationToolClassifier,
): EvaluationToolGate {
  // Rows frozen before the whitelist existed (the T22 shape) carry no `readOnlyTools`;
  // absence reads as empty rather than permissive — everything is refused.
  const whitelist = new Set(
    (config.readOnlyTools ?? [])
      .filter((name) => name.state === "projected")
      .map((name) => name.text),
  );
  const rejectedTools = new Set<string>();
  let rejections = 0;

  const fixtureFor = (toolName: string, fixtures: readonly SafeValue[]) => {
    for (const one of fixtures) {
      if (one.state !== "projected") continue;
      const value = one.value;
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        toolName in value
      ) {
        return (value as Record<string, unknown>)[toolName];
      }
    }
    return undefined;
  };

  return {
    call(toolName, fixtures) {
      const refuse = (reason: ToolRefusalReason): EvaluationToolCall => {
        rejections += 1;
        rejectedTools.add(toolName);
        return { outcome: "refused", reason };
      };
      // 1. Not whitelisted — the fail-closed default. Unknown tools land here: a name
      //    the frozen configuration never listed is refused, never silently skipped.
      if (!whitelist.has(toolName)) return refuse("not_whitelisted");
      // 2. Whitelisted but still a production write. The whitelist may narrow what an
      //    evaluation may call; it may never promote a write into a read.
      if (classify(toolName) === "write") return refuse("write_tool");
      // 3. Whitelisted and read-only, but nothing frozen stands in for the call. There
      //    is no honest answer to give, so the call is refused rather than guessed at.
      const fixture = fixtureFor(toolName, fixtures);
      if (fixture === undefined) return refuse("no_fixture");
      return { outcome: "replayed", fixture };
    },
    tally: () => ({
      rejections,
      rejectedTools: [...rejectedTools].sort(),
    }),
  };
}

/** What one frozen case is handed — frozen content only, and the one tool seam. */
export type EvaluationCaseContext = Readonly<{
  executionId: string;
  experimentId: string;
  caseIndex: number;
  /** The frozen case: projected input, reference output, fixtures, provenance ids. */
  frozenCase: FrozenDatasetCase;
  /** The frozen experiment configuration, whitelist included. */
  config: FrozenExperimentConfig;
  /**
   * The namespace this case runs under, re-derived from LIVE authorization immediately
   * before the case starts (T24). Inert identity data — a key and two ids — not a
   * production handle: the case still has no session, memory or business-data reach.
   * The production runner carries it on its observations so they land in the right
   * scope's channel instead of being dropped as scope-less.
   */
  scope: ObservationScope;
  /**
   * The ONLY way this case may touch a tool. It never executes anything live: a call
   * replays a frozen fixture or is refused with a reason. There is no session, memory,
   * learning or business-data handle in this context at all — isolation by construction.
   */
  callTool: (toolName: string) => Promise<EvaluationToolCall>;
}>;

/** Runs one case to an honest outcome. The production runner is a later ticket's work. */
export type EvaluationCaseRunner = (
  context: EvaluationCaseContext,
) => Promise<EvaluationCaseOutcome>;

/** The billing precheck this slice hangs execution starts on (settlement itself is T25). */
export type ExecutionBudgetPrecheck = (input: {
  actorId: string;
  botId: string;
  experimentId: string;
}) => Promise<{ allowed: true } | { allowed: false; reason?: string }>;

export type ObservationExecution =
  typeof aiObservationExperimentExecutions.$inferSelect;

/** One per-case write-ahead row: `in_flight` before the call, the observed status after. */
export type ObservationCaseOutcome =
  typeof aiObservationExecutionCaseOutcomes.$inferSelect;

export type ObservationExecutionStore = {
  /**
   * Queue one execution of a frozen experiment inside the caller's scope. One
   * transaction writes the execution row and its claim ticket. A draft — or any
   * row not frozen — is refused here: the execution vocabulary has no word for
   * "ran under a mutable configuration".
   */
  enqueue(
    scope: ObservationScope,
    experimentId: string,
  ): Promise<ObservationExecution>;
  /** Read one execution inside the caller's scope. Another scope's id is simply not found. */
  get(
    scope: ObservationScope,
    id: string,
  ): Promise<ObservationExecution | null>;
  /** One experiment's executions inside the caller's scope, newest first. */
  list(
    scope: ObservationScope,
    experimentId: string,
  ): Promise<readonly ObservationExecution[]>;
  /**
   * The revocation seam: settle every pending or running execution of one actor as
   * cancelled. Runs exactly when the actor's authorization is gone; already-terminal
   * executions are untouched, because the first terminal write wins. Returns the
   * cancelled rows — the caller's audit path needs what each row knew.
   */
  cancelForActor(actorId: string): Promise<readonly ObservationExecution[]>;
  /** Worker-side read by id. Trust is the lease the worker holds, not a scope. */
  loadById(id: string): Promise<ObservationExecution | null>;
  /** pending (or lease-orphaned running) → running. Null when gone or already terminal. */
  markRunning(id: string): Promise<ObservationExecution | null>;
  /**
   * The per-case write-ahead marker: insert `in_flight` for this case, BEFORE its
   * invocation, and only while the execution is still running. False when the row
   * already exists (another worker marked, ran, or died on this case) or the
   * execution left running — the caller reads the row to tell those apart.
   */
  markCaseStarted(id: string, caseIndex: number): Promise<boolean>;
  /**
   * Land one case's observed outcome: one conditional flip `in_flight` → final,
   * the output and usage projected once on the way in, each with its own budget
   * (T28's result contract). False when the case's truth was already written — by
   * this worker, or by a takeover that honestly recorded `unknown` for a call whose
   * outcome nobody observed.
   */
  recordCaseOutcome(
    id: string,
    caseIndex: number,
    status: EvaluationCaseStatus,
    output?: unknown,
    usage?: unknown,
    judge?: unknown,
  ): Promise<boolean>;
  /** One case's write-ahead row, whatever its status. Null when the case never started. */
  caseOutcome(
    id: string,
    caseIndex: number,
  ): Promise<ObservationCaseOutcome | null>;
  /** One execution's case rows in case order — the resume path's map of what already ran. */
  caseOutcomes(id: string): Promise<readonly ObservationCaseOutcome[]>;
  /**
   * The one place per-case outcomes land: conditional on still running, and every
   * case's output and usage are projected before they are stored. Null when
   * revocation won the row.
   */
  settleCompleted(
    id: string,
    cases: readonly {
      index: number;
      status: EvaluationCaseStatus;
      output?: unknown;
      usage?: unknown;
      judge?: unknown;
    }[],
  ): Promise<ObservationExecution | null>;
  /**
   * Settle completed from the durable per-case rows themselves (the worker's path):
   * what ran is what the rows say, not what any worker remembers. Any row still
   * `in_flight` at settle time is assembled as `unknown` — an ending nobody observed.
   * The result lands the T28 contract (`{cases:[{index,status,output?,usage?}]}`),
   * embedding each field's stored envelope as-is — the same shape `settleCompleted`
   * writes, so the read side (T28's `results`) cannot tell which path settled.
   */
  settleCompletedFromOutcomes(id: string): Promise<ObservationExecution | null>;
  /** Record why an execution failed. Conditional on still running, like completion. */
  settleFailed(
    id: string,
    code: ExecutionJobErrorCode,
  ): Promise<ObservationExecution | null>;
  /** Cancel one execution outright (the authorization-gone path the worker takes). */
  settleCancelled(id: string): Promise<ObservationExecution | null>;
  /** Add refused tool calls to the governance counter while the execution still runs. */
  bumpToolRejections(id: string, count: number): Promise<void>;
};

/** A non-empty opaque reference. Values are stored as-is; only emptiness is refused. */
function reference(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExecutionError("EXECUTION_INPUT_INVALID", 400);
  }
  return value;
}

/** The statuses `recordCaseOutcome` accepts: every case outcome is final, never `in_flight`. */
const CASE_OUTCOME_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "unknown",
]);

function assertCaseIndex(caseIndex: number): void {
  if (!Number.isInteger(caseIndex) || caseIndex < 0) {
    throw new ExecutionError("EXECUTION_INPUT_INVALID", 400);
  }
}

export function createObservationExecutionStore(
  db: Database,
): ObservationExecutionStore {
  const settle = (
    id: string,
    values: Partial<typeof aiObservationExperimentExecutions.$inferInsert>,
  ) =>
    db
      .update(aiObservationExperimentExecutions)
      .set({ ...values, updatedAt: new Date(), settledAt: new Date() })
      // Only a running execution settles. A cancelled row refuses this write, which
      // is exactly the race revocation must win.
      .where(
        and(
          eq(aiObservationExperimentExecutions.id, id),
          eq(aiObservationExperimentExecutions.state, "running"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

  return {
    async enqueue(scope, experimentId) {
      assertObservationScope(scope);
      reference(experimentId);
      const id = randomUUID();
      return db.transaction(async (tx) => {
        // The experiment is read inside the caller's scope and held for update, so a
        // submit racing this enqueue freezes the row exactly once and this read sees
        // which side won — a draft here is a refusal, not a retry.
        const found = await tx
          .select()
          .from(aiObservationExperiments)
          .where(
            and(
              eq(aiObservationExperiments.id, experimentId),
              eq(aiObservationExperiments.scopeKey, scope.key),
            ),
          )
          .for("update");
        const experiment = found[0];
        if (!experiment) {
          throw new ExecutionError("EXECUTION_EXPERIMENT_NOT_FOUND", 404);
        }
        if (experiment.state !== "frozen" || experiment.configHash === "") {
          throw new ExecutionError("EXECUTION_EXPERIMENT_NOT_FROZEN", 409);
        }
        const [row] = await tx
          .insert(aiObservationExperimentExecutions)
          .values({
            id,
            scopeKey: scope.key,
            actorId: scope.actorId,
            botId: scope.botId,
            experimentId: experiment.id,
            experimentConfigHash: experiment.configHash,
            state: "pending",
          })
          .returning();
        if (!row) {
          throw new Error("enqueue inserted a row it cannot read back");
        }
        // The claim ticket, in the same transaction: a pending execution always has
        // one and a ticket always has its execution. Idempotent on (kind, key); the
        // key is the execution id, so it never collides.
        await tx
          .insert(workItems)
          .values({ kind: EXECUTION_WORK_KIND, key: row.id })
          .onConflictDoNothing();
        return row;
      });
    },

    async get(scope, id) {
      assertObservationScope(scope);
      reference(id);
      const rows = await db
        .select()
        .from(aiObservationExperimentExecutions)
        .where(
          and(
            eq(aiObservationExperimentExecutions.id, id),
            eq(aiObservationExperimentExecutions.scopeKey, scope.key),
          ),
        );
      return rows[0] ?? null;
    },

    async list(scope, experimentId) {
      assertObservationScope(scope);
      reference(experimentId);
      return db
        .select()
        .from(aiObservationExperimentExecutions)
        .where(
          and(
            eq(aiObservationExperimentExecutions.scopeKey, scope.key),
            eq(aiObservationExperimentExecutions.experimentId, experimentId),
          ),
        )
        .orderBy(desc(aiObservationExperimentExecutions.createdAt));
    },

    async cancelForActor(actorId) {
      reference(actorId);
      const cancelled = await db
        .update(aiObservationExperimentExecutions)
        .set({
          state: "cancelled",
          updatedAt: new Date(),
          settledAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExperimentExecutions.actorId, actorId),
            inArray(aiObservationExperimentExecutions.state, [
              "pending",
              "running",
            ]),
          ),
        )
        .returning();
      return cancelled;
    },

    async loadById(id) {
      reference(id);
      const rows = await db
        .select()
        .from(aiObservationExperimentExecutions)
        .where(eq(aiObservationExperimentExecutions.id, id));
      return rows[0] ?? null;
    },

    async markRunning(id) {
      reference(id);
      // A lease-orphaned running execution is claimable again: the work-item lease the
      // caller holds is the proof the previous owner is gone, and the conditional
      // settles keep a takeover from double-landing results.
      const rows = await db
        .update(aiObservationExperimentExecutions)
        .set({
          state: "running",
          startedAt: sql`coalesce(${aiObservationExperimentExecutions.startedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExperimentExecutions.id, id),
            inArray(aiObservationExperimentExecutions.state, [
              "pending",
              "running",
            ]),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async settleCompleted(id, cases) {
      reference(id);
      /*
       * The result contract (T28): one record per case, and each case's fields carry
       * their OWN projection budget. The T23 shape projected the whole `{cases}` tree in
       * one pass, which cut every envelope past MAX_SAFE_RECORD_DEPTH — a case's output
       * and usage, five levels down, could never survive a settlement. Projecting per
       * field keeps the T05 doctrine exactly where it was — no naked free text reaches
       * this column at any depth, the deny patterns always win — while letting the
       * scoreable output and the usage record land intact. The model output is
       * projected with `allowFreeText`: the evaluation runner is the caller asserting
       * this content is handled, and even that assertion cannot license a credential.
       */
      return settle(id, {
        state: "completed",
        caseCount: cases.length,
        result: {
          cases: cases.map((one) => ({
            index: one.index,
            status: one.status,
            output:
              one.output === undefined
                ? undefined
                : typeof one.output === "string"
                  ? projectSafeText(one.output, { allowFreeText: true })
                  : projectSafeFixture(one.output),
            ...(one.usage === undefined
              ? {}
              : { usage: projectSafeFixture(one.usage) }),
            ...(one.judge === undefined
              ? {}
              : { judge: projectSafeFixture(one.judge) }),
          })),
        },
      });
    },

    async settleCompletedFromOutcomes(id) {
      reference(id);
      const rows = await db
        .select()
        .from(aiObservationExecutionCaseOutcomes)
        .where(eq(aiObservationExecutionCaseOutcomes.executionId, id))
        .orderBy(asc(aiObservationExecutionCaseOutcomes.caseIndex));
      // The rows ARE the projection's output — each field's envelope was projected
      // once at record time with its own budget — so this lands the same T28
      // contract `settleCompleted` writes, embedding the stored envelopes as-is
      // instead of projecting (and depth-cutting) them a second time.
      const cases = rows.map((row) => {
        const detail = row.detail as {
          output?: SafeValue | SafeText;
          usage?: SafeValue;
          judge?: SafeValue;
        } | null;
        return {
          index: row.caseIndex,
          // A row still in flight at settle time is an ending nobody observed.
          status: row.status === "in_flight" ? "unknown" : row.status,
          ...(detail?.output !== undefined ? { output: detail.output } : {}),
          ...(detail?.usage !== undefined ? { usage: detail.usage } : {}),
          ...(detail?.judge !== undefined ? { judge: detail.judge } : {}),
        };
      });
      return settle(id, {
        state: "completed",
        caseCount: rows.length,
        result: { cases },
      });
    },

    async settleFailed(id, code) {
      reference(id);
      if (!(EXECUTION_JOB_ERROR_CODES as readonly string[]).includes(code)) {
        // The stored failure vocabulary is closed: an unknown code on an execution row
        // is a lie future readers would trust, so it is refused here too.
        throw new ExecutionError("EXECUTION_STATE_INVALID", 500);
      }
      return settle(id, { state: "failed", errorCode: code });
    },

    async settleCancelled(id) {
      reference(id);
      // Both not-yet-terminal states: the worker cancels an execution it has only
      // just claimed (still pending) exactly like one it is running.
      const rows = await db
        .update(aiObservationExperimentExecutions)
        .set({
          state: "cancelled",
          updatedAt: new Date(),
          settledAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExperimentExecutions.id, id),
            inArray(aiObservationExperimentExecutions.state, [
              "pending",
              "running",
            ]),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    async markCaseStarted(id, caseIndex) {
      reference(id);
      assertCaseIndex(caseIndex);
      // One statement, three facts: the marker is born only if the case has none
      // (the primary key), only while the execution is running (the EXISTS guard —
      // a cancelled or settled execution schedules nothing new), and this caller
      // learns whether the insert was its own.
      const written = await db.execute(sql`
        insert into "ai_observation_execution_case_outcomes" ("execution_id", "case_index", "status")
        select ${id}, ${caseIndex}, 'in_flight'
        where exists (
          select 1 from "ai_observation_experiment_executions" e
          where e."id" = ${id} and e."state" = 'running'
        )
        on conflict do nothing
        returning "execution_id"
      `);
      const rows = (
        Array.isArray(written)
          ? written
          : ((written as { rows?: unknown[] })?.rows ?? [])
      ) as unknown[];
      return rows.length > 0;
    },

    async recordCaseOutcome(id, caseIndex, status, output, usage, judge) {
      reference(id);
      assertCaseIndex(caseIndex);
      if (typeof status !== "string" || !CASE_OUTCOME_STATUSES.has(status)) {
        throw new ExecutionError("EXECUTION_INPUT_INVALID", 400);
      }
      // One conditional flip: only the worker whose marker still stands may land an
      // outcome. A takeover that recorded `unknown` closes the row; the original
      // owner's later write is refused, which is the no-double-truth guarantee.
      // Deliberately NOT conditional on the execution still running: an outcome that
      // was observed is a fact, and recording it after a cancellation is honest.
      const rows = await db
        .update(aiObservationExecutionCaseOutcomes)
        .set({
          status,
          detail:
            output === undefined && usage === undefined && judge === undefined
              ? null
              : {
                  // T28's per-field projection budget, paid once here: the same
                  // projections `settleCompleted` would make, so the write-ahead
                  // row and a direct settle land the same contract.
                  ...(output === undefined
                    ? {}
                    : {
                        output:
                          typeof output === "string"
                            ? projectSafeText(output, { allowFreeText: true })
                            : projectSafeFixture(output),
                      }),
                  ...(usage === undefined
                    ? {}
                    : { usage: projectSafeFixture(usage) }),
                  // The judge record is a fixture-shaped scoring fact (T27): its
                  // rationale is already a projected envelope, so it rides the deep
                  // fixture projection like any other structured content.
                  ...(judge === undefined
                    ? {}
                    : { judge: projectSafeFixture(judge) }),
                },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExecutionCaseOutcomes.executionId, id),
            eq(aiObservationExecutionCaseOutcomes.caseIndex, caseIndex),
            eq(aiObservationExecutionCaseOutcomes.status, "in_flight"),
          ),
        )
        .returning({
          executionId: aiObservationExecutionCaseOutcomes.executionId,
        });
      return rows.length > 0;
    },

    async caseOutcome(id, caseIndex) {
      reference(id);
      assertCaseIndex(caseIndex);
      const rows = await db
        .select()
        .from(aiObservationExecutionCaseOutcomes)
        .where(
          and(
            eq(aiObservationExecutionCaseOutcomes.executionId, id),
            eq(aiObservationExecutionCaseOutcomes.caseIndex, caseIndex),
          ),
        );
      return rows[0] ?? null;
    },

    async caseOutcomes(id) {
      reference(id);
      return db
        .select()
        .from(aiObservationExecutionCaseOutcomes)
        .where(eq(aiObservationExecutionCaseOutcomes.executionId, id))
        .orderBy(asc(aiObservationExecutionCaseOutcomes.caseIndex));
    },

    async bumpToolRejections(id, count) {
      reference(id);
      if (!Number.isInteger(count) || count < 1) {
        throw new ExecutionError("EXECUTION_INPUT_INVALID", 400);
      }
      // Conditional on running: a revocation that landed mid-run wins the row, and
      // refusals after it belong to an execution that no longer exists.
      await db
        .update(aiObservationExperimentExecutions)
        .set({
          toolRejections: sql`${aiObservationExperimentExecutions.toolRejections} + ${count}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiObservationExperimentExecutions.id, id),
            eq(aiObservationExperimentExecutions.state, "running"),
          ),
        );
    },
  };
}

/**
 * The start seam with the billing precheck (T20's layering: the store queues, the
 * service gates). The precheck runs BEFORE anything is written: a budget the billing
 * seam will not cover means the execution never starts — no row, no claim ticket,
 * nothing for a worker to pick up. This is the fail-closed start of Issue #29; the
 * actual reservation and settlement of what a run consumed belong to T25, which
 * replaces this seam's wiring without changing its contract.
 */
export type ExperimentExecutionService = Readonly<{
  start(
    scope: ObservationScope,
    experimentId: string,
  ): Promise<ObservationExecution>;
}>;

export function createExperimentExecutionService(
  deps: Readonly<{
    executions: Pick<ObservationExecutionStore, "enqueue">;
    billing: Readonly<{ precheck: ExecutionBudgetPrecheck }>;
  }>,
): ExperimentExecutionService {
  return {
    async start(scope, experimentId) {
      assertObservationScope(scope);
      const budget = await deps.billing.precheck({
        actorId: scope.actorId,
        botId: scope.botId,
        experimentId,
      });
      if (!budget?.allowed) {
        throw new ExecutionError("EXECUTION_BUDGET_REFUSED", 402);
      }
      return deps.executions.enqueue(scope, experimentId);
    },
  };
}

/** Live authorization for an execution's actor and bot, or null when it is gone. */
export type ExecutionReauthorization = (input: {
  actorId: string;
  botId: string;
}) => Promise<ObservationScope | null>;

export type ObservationExecutionWorker = {
  /** One pass: claim up to the concurrency bound and run the batch to completion. */
  sweep(): Promise<void>;
  /** Poll-driven scheduling on the house loop. Tests drive `sweep` directly. */
  start(): Repeating;
};

export type ObservationExecutionWorkerDeps = Readonly<{
  database: Database;
  /** The governance channel: the settle row carries the refusal counter into the trail. */
  audit: Pick<AuditStore, "insert">;
  /** The production read/write classifier; wiring builds this over the plugin catalogue. */
  classify: EvaluationToolClassifier;
  /** Runs one frozen case to an honest outcome. The production runner is a later ticket. */
  runCase: EvaluationCaseRunner;
  /**
   * The scope is re-derived from live authorization for every execution — the T06
   * obligation for background workers. Null means revoked: the execution is cancelled
   * and no case runs at all.
   */
  reauthorize: ExecutionReauthorization;
  store?: ObservationExecutionStore;
  queue?: WorkQueue;
  concurrency?: number;
  leaseMs?: number;
  pollMs?: number;
  owner?: string;
}>;

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_MS = 2_000;
/** Distinct refused tool names the settle audit row carries; enough to steer a review. */
const MAX_AUDITED_TOOL_NAMES = 32;

/** Internal: the work-item lease was taken over; another owner owns the truth now. */
class ExecutionLeaseLost extends Error {}

/**
 * The settle audit row: what ended, against which frozen experiment, how many cases
 * ran, and how many production tool calls were refused. It follows the database fact
 * deliberately (the T22 precedent): the row is the truth, the trail is its record,
 * and a trail write that fails is logged — never allowed to un-settle an execution.
 *
 * Tool names are projected before they land (T23-rev L-2): after T24 the names come
 * from a runner, which is to say from a model, and an audit payload is a record.
 */
async function auditExecutionSettled(
  audit: Pick<AuditStore, "insert">,
  input: {
    execution: Pick<
      ObservationExecution,
      "id" | "experimentId" | "experimentConfigHash" | "actorId"
    >;
    settled: Pick<ObservationExecution, "state" | "caseCount" | "errorCode">;
    tally: Pick<ToolGateTally, "rejections" | "rejectedTools">;
  },
): Promise<void> {
  const { execution, settled, tally } = input;
  const log = getLogger("server");
  try {
    await recordAuditEvent(audit, {
      eventType: "opik.experiment_execution_settled",
      targetType: "ai_observation_experiment_execution",
      targetId: execution.id,
      actorUserId: execution.actorId,
      payload: {
        executionId: execution.id,
        experimentId: execution.experimentId,
        experimentConfigHash: execution.experimentConfigHash,
        state: settled.state,
        caseCount: settled.caseCount,
        errorCode: settled.errorCode,
        toolRejections: tally.rejections,
        rejectedTools: tally.rejectedTools
          .slice(0, MAX_AUDITED_TOOL_NAMES)
          .map((name): SafeText => projectSafeName(name)),
      },
    });
  } catch (error) {
    log.warn(
      {
        type: "opik-execution-audit-failed",
        executionId: execution.id,
        error: String(error),
      },
      "opik-execution-audit-failed",
    );
  }
}

/**
 * The audited revocation seam: cancel every active execution of one actor and leave
 * a settle audit row for each (T23-rev L-1 — a cancelled execution with mid-run
 * refusals must reach the governance channel, not just the row's counter). The row's
 * `tool_rejections` is the truth here; the distinct names live only in a live gate's
 * memory and are honestly absent from this path's payload.
 */
export async function cancelExecutionsForActor(
  deps: Readonly<{
    executions: Pick<ObservationExecutionStore, "cancelForActor">;
    audit: Pick<AuditStore, "insert">;
  }>,
  actorId: string,
): Promise<readonly ObservationExecution[]> {
  const cancelled = await deps.executions.cancelForActor(actorId);
  for (const execution of cancelled) {
    await auditExecutionSettled(deps.audit, {
      execution,
      settled: execution,
      tally: { rejections: execution.toolRejections, rejectedTools: [] },
    });
  }
  return cancelled;
}

export function createObservationExecutionWorker(
  deps: ObservationExecutionWorkerDeps,
): ObservationExecutionWorker {
  const log = getLogger("server");
  const store = deps.store ?? createObservationExecutionStore(deps.database);
  const queue = deps.queue ?? createWorkQueue(deps.database);
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const owner = deps.owner ?? workOwner("opik-execution");

  const auditSettle = (
    execution: ObservationExecution,
    settled: ObservationExecution,
    tally: ToolGateTally,
  ) =>
    auditExecutionSettled(deps.audit, {
      execution,
      settled,
      tally,
    });

  const run = async (key: string, renew: () => Promise<boolean>) => {
    const finish = () =>
      queue.finish({ kind: EXECUTION_WORK_KIND, key, owner });
    const execution = await store.loadById(key);
    if (
      !execution ||
      isTerminalExecutionState(parseExecutionState(execution.state))
    ) {
      // A ticket whose execution is gone or settled: nothing to run, nothing to
      // reschedule. (A cancelled execution's ticket lands here on its next claim.)
      await finish();
      return;
    }

    /*
     * Re-derive the scope from live authorization. A revoked actor, a transferred bot
     * or a bumped epoch answers differently than the scope the execution was enqueued
     * under — including null — and every one of those answers cancels the execution
     * before a single case runs.
     */
    const scope = await deps.reauthorize({
      actorId: execution.actorId,
      botId: execution.botId,
    });
    if (scope === null) {
      // Cancelled before a single case, and audited like every settle (T23-rev L-1):
      // the gate has not run, so the tally is an honest zero.
      const settled = await store.settleCancelled(execution.id);
      if (settled) {
        await auditSettle(execution, settled, {
          rejections: 0,
          rejectedTools: [],
        });
      }
      await finish();
      return;
    }

    // The frozen experiment, read by id: the enqueue already refused anything but a
    // frozen row, and frozen rows cannot change — this re-check is the belt to that
    // suspenders, and the fail-closed answer to any drift is a refused execution.
    const experimentRows = await deps.database
      .select()
      .from(aiObservationExperiments)
      .where(eq(aiObservationExperiments.id, execution.experimentId));
    const experiment = experimentRows[0];
    if (
      // biome-ignore lint/complexity/useOptionalChain: the || form is what narrows experiment for the reads below.
      !experiment ||
      experiment.state !== "frozen" ||
      experiment.scopeKey !== scope.key ||
      experiment.configHash !== execution.experimentConfigHash
    ) {
      const settled = await store.settleFailed(
        execution.id,
        "EXPERIMENT_NOT_FROZEN",
      );
      if (settled)
        await auditSettle(execution, settled, {
          rejections: 0,
          rejectedTools: [],
        });
      await finish();
      return;
    }

    // The pinned dataset version, still owned by the scope the world would issue now.
    const versionRows = await deps.database
      .select()
      .from(aiObservationDatasetVersions)
      .where(eq(aiObservationDatasetVersions.id, experiment.datasetVersionId));
    const version = versionRows[0];
    if (!version || version.scopeKey !== scope.key) {
      const settled = await store.settleFailed(
        execution.id,
        "DATASET_VERSION_MISSING",
      );
      if (settled)
        await auditSettle(execution, settled, {
          rejections: 0,
          rejectedTools: [],
        });
      await finish();
      return;
    }

    const claimed = await store.markRunning(execution.id);
    if (!claimed) {
      // Cancelled between the read and the claim of running.
      await finish();
      return;
    }

    const gate = createEvaluationToolGate(experiment.config, deps.classify);
    const config = experiment.config;
    let lastTally = 0;

    try {
      for (const [index, frozenCase] of version.cases.entries()) {
        if (!(await renew())) {
          throw new ExecutionLeaseLost();
        }
        // Re-authorization BEFORE every sample (the T06 obligation, per case in T24):
        // a revocation that lands between cases stops the run at the boundary — no
        // case after it runs, reads, or consumes anything, and the cancel is audited.
        const live = await deps.reauthorize({
          actorId: execution.actorId,
          botId: execution.botId,
        });
        if (live === null) {
          const settled = await store.settleCancelled(execution.id);
          if (settled) await auditSettle(execution, settled, gate.tally());
          await finish();
          return;
        }
        // The write-ahead marker, before any invocation. A row that already exists is
        // this execution's own durable memory: a final row is a completed sample to
        // skip; an in_flight row is a call whose outcome nobody observed — recorded
        // unknown and never invoked again, which is the no-double-billing promise.
        const started = await store.markCaseStarted(execution.id, index);
        if (!started) {
          const existing = await store.caseOutcome(execution.id, index);
          if (!existing) {
            // No marker could be written: the execution left running — a cancel or a
            // settle won the row between the re-authorization and now. Nothing new
            // is scheduled on a settled execution.
            await finish();
            return;
          }
          if (existing.status === "in_flight") {
            await store.recordCaseOutcome(execution.id, index, "unknown");
          }
          continue;
        }
        const outcome = await deps.runCase({
          executionId: execution.id,
          experimentId: execution.experimentId,
          caseIndex: index,
          frozenCase,
          config,
          scope: live,
          callTool: async (toolName) =>
            gate.call(toolName, [frozenCase.toolFixtures, config.toolFixtures]),
        });
        await store.recordCaseOutcome(
          execution.id,
          index,
          outcome.status,
          outcome.output,
          outcome.usage,
          outcome.judge,
        );
        // The governance counter follows each case, so a run that dies mid-way has
        // already recorded the refusals that happened.
        const tally = gate.tally();
        const delta = tally.rejections - lastTally;
        if (delta > 0) {
          await store.bumpToolRejections(execution.id, delta);
          lastTally = tally.rejections;
        }
      }
      // Settled from the durable rows, not from memory: what ran is what the rows
      // say, whatever process started them.
      const settled = await store.settleCompletedFromOutcomes(execution.id);
      if (settled) await auditSettle(execution, settled, gate.tally());
    } catch (error) {
      if (error instanceof ExecutionLeaseLost) {
        // Another owner holds the ticket; the truth is theirs to write.
        return;
      }
      const settled = await store.settleFailed(
        execution.id,
        "CASE_EXECUTION_ERROR",
      );
      if (settled) await auditSettle(execution, settled, gate.tally());
    }
    await finish();
  };

  const sweeping = { current: false };
  const sweep = async () => {
    // Never overlapping: a second pass while one runs would claim a second batch and
    // the bound would be the backlog, not the configuration.
    if (sweeping.current) return;
    sweeping.current = true;
    try {
      const items = await queue.claim({
        kind: EXECUTION_WORK_KIND,
        owner,
        leaseMs,
        limit: concurrency,
      });
      await Promise.all(
        items.map((item) =>
          run(item.key, () =>
            queue.renew({
              kind: EXECUTION_WORK_KIND,
              key: item.key,
              owner,
              leaseMs,
            }),
          ).catch((error) => {
            // The execution row keeps its own truth; a runner crash must not take
            // the sweep (and the poll loop behind it) down with it.
            log.warn(
              { type: "opik-execution-run-failed", key: item.key },
              "opik-execution-run-failed",
            );
            void error;
          }),
        ),
      );
    } finally {
      sweeping.current = false;
    }
  };

  return {
    sweep,
    start: () =>
      repeatAfterEach(async () => {
        try {
          await sweep();
        } catch (error) {
          log.warn(
            { type: "opik-execution-sweep-failed", error: String(error) },
            "opik-execution-sweep-failed",
          );
        }
      }, deps.pollMs ?? DEFAULT_POLL_MS),
  };
}
