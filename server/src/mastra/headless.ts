/**
 * ME09 (#481): one governed headless turn — the routine firing that runs
 * through the SAME controlled Mastra execution the web chat runs, with no
 * browser and no Intelligence socket anywhere on the path.
 *
 * WHAT THE LEGACY TURN DID THAT THIS ONE DOES NOT. `routines/run-turn.ts`
 * drives an AbstractAgent through the Intelligence gateway's runner socket:
 * its history comes from the platform, its lock is the platform's thread
 * lock, its reply is diffed off the agent. This runner replaces every one of
 * those authorities with the OpenBot ones the governed admission already
 * owns: history is rebuilt from the conversation store by the conversation
 * runtime (`loadExecutionInput`), the produced answer is persisted back
 * through the single-writer seam (`persistExecutionMessages`) BEFORE the run
 * can complete, and the lock is the runs service' request lease — acquired,
 * renewed on a cadence, and released on every exit path, exactly the
 * discipline `run-turn.ts`'s finally block states, over a lease the database
 * already fences instead of a socket.
 *
 * THE INTENT IS THE IDEMPOTENCE (ticket AC3). One firing = one advance
 * intent = one `clientMessageKey`. The key is derived from the ROUTINE id and
 * the FIRING id — never from a queue tenant/owner string — and every durable
 * write the turn makes (the submitted message append, the run admission) is
 * idempotent or refusing on it: a queue redelivery or a second worker
 * dispatching the same firing appends the same message (converges), then
 * `runs.start` refuses with RUN_IDEMPOTENCY_CONFLICT, which this runner
 * surfaces as {@link GovernedHeadlessRefusal} `ROUTINE_INTENT_ALREADY_ADVANCED`
 * — one advancement, one budget reservation, whatever the delivery count.
 *
 * THE SCHEDULING RECORD IS THE AUTHORIZATION TO FIRE (ticket AC1). The
 * runner re-reads the persistent scheduling record at the moment of running
 * and refuses a caller whose thread/Bot disagrees with it: a payload that
 * survived the queue cannot redirect a firing to another thread, another
 * Bot, or another owner. The scope is then re-issued FROM THE DIRECTORY for
 * that record's owner and thread (current membership epochs, current
 * conversation ownership) — a scope string that traveled through a queue is
 * not an identity.
 *
 * THE BUDGET IS EXPLICIT AND THE PAYER IS FIXED (ticket AC2). The ceiling is
 * the server-side model route's own token cap read at firing time; missing
 * or malformed route configuration is a named refusal
 * (`ROUTINE_BUDGET_UNCONFIGURED`), never a guessed default company or an
 * unlimited run. The payer is the admitted scope's own principal, locked by
 * the admission's budget reservation.
 */

import { createHash } from "node:crypto";
import type { BaseEvent } from "@ag-ui/client";
import { getLogger } from "../../../shared/logger";
import { frameFiring } from "../../../shared/routine-firing";
import type { AuditInitiator } from "../audit";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type {
  ConversationService,
  PlatformScope,
  RunFailureCode,
  RunnerRequestLease,
  RunService,
  TrustedRunAdmission,
} from "../enterprise/contracts";
import { messageDigest } from "../enterprise/conversations/store";
import type {
  ExpertDefinitionV1,
  ExpertVersionRef,
} from "../enterprise/experts/version-catalog";
import {
  classifyGovernedRunFailure,
  type GovernedModelExecution,
} from "../enterprise/runs/governed-execution";
import { isPositiveInt32TokenCount } from "../enterprise/runs/output-ceiling";
import { RunDomainError } from "../enterprise/runs/store";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { TurnRunner } from "../routines/runner";
import {
  MASTRA_CONTINUATION_REFUSALS,
  MastraContinuationRefusal,
} from "./continuation-store";
import {
  createProducedMessageCollector,
  type MastraConversationRuntime,
} from "./conversation-runtime";
import type {
  ExecutionBinding,
  ExecutionContinuationContext,
  FrontendToolDefinition,
  LearnedSkillInvocationSurface,
} from "./execution-contracts";
import { executeGovernedMastra } from "./governed-agent";

const log = getLogger("server");

/** How long one governed headless turn may take before it is stopped. */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;

/** The request-lease renewal cadence: comfortably inside a 30s lease window. */
const DEFAULT_LEASE_RENEW_MS = 10_000;

/** The named refusals a governed headless turn produces. */
export const GOVERNED_HEADLESS_REFUSALS = {
  /** The scheduling record is gone (the routine was deleted under the firing). */
  recordGone: "ROUTINE_SCHEDULING_RECORD_GONE",
  /** The caller's firing context disagrees with the persistent record. */
  contextMismatch: "ROUTINE_FIRING_CONTEXT_MISMATCH",
  /** No explicit budget: the server-side route/ceiling did not resolve. */
  budgetUnconfigured: "ROUTINE_BUDGET_UNCONFIGURED",
  /** This advance intent was already claimed — a redelivery, never a second run. */
  intentAlreadyAdvanced: "ROUTINE_INTENT_ALREADY_ADVANCED",
} as const;

/** A named refusal of the governed headless admission (before any model dial). */
export class GovernedHeadlessRefusal extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "GovernedHeadlessRefusal";
  }
}

/**
 * The clientMessageKey of ONE firing's advance intent: deterministic in
 * (routineId, firingId), so a redelivery of the same firing derives the SAME
 * key and converges on the first run instead of minting a second one. The
 * `routine-adv:` prefix keeps routine keys out of every other key namespace
 * on the thread; the capped form hashes the tail so the key can never exceed
 * the ConversationService's 200-code-point cap regardless of caller ids.
 */
export function governedFiringIntentKey(
  routineId: string,
  firingId: string,
): string {
  const plain = `routine-adv:${routineId}:${firingId}`;
  if (plain.length <= 200) return plain;
  return `routine-adv:sha256:${createHash("sha256")
    .update(`${routineId}\n${firingId}`)
    .digest("hex")}`;
}

/**
 * The ME06 composed generation gate, extracted from the production wiring so
 * the composed callback (`runs.getActiveAttemptGeneration` behind the
 * refusals-to-false adapter) has ONE definition that both `index.ts` and the
 * production-level tests drive. A run whose current attempt generation has
 * moved (a stopped run) — or whose read fails (absence) — is no longer the
 * generation a continuation binds.
 */
export function createGenerationCurrentGate(
  runs: Pick<RunService, "getActiveAttemptGeneration">,
): (input: {
  scope: PlatformScope;
  runId: string;
  attemptId?: string;
  generation: number;
}) => Promise<boolean> {
  return async ({ scope, runId, attemptId, generation }) => {
    try {
      return (
        (await runs.getActiveAttemptGeneration(
          scope,
          runId,
          attemptId ?? "",
        )) === generation
      );
    } catch {
      return false;
    }
  };
}

/** The named refusals the governed resume drive's run settlement produces. */
export const MASTRA_RESUME_SETTLE_REFUSALS = {
  /**
   * The drive finished but its usage settlement was refused or absent: the
   * run was settled FAILED with the classified code — never succeeded.
   */
  settlementUnverified: "MASTRA_RESUME_SETTLEMENT_UNVERIFIED",
  /**
   * The drive finished clean but the completion itself was refused (a lease
   * that died mid-drive); the truthful failure settlement went through.
   */
  completionStale: "MASTRA_RESUME_COMPLETION_STALE",
  /**
   * The held lease settled the run NEITHER succeeded NOR failed: the run
   * stays in its waiting status, the lease is released, and the resume
   * outcome is an explicit named isolation — never a silent "resumed".
   */
  runUnsettled: "MASTRA_RESUME_RUN_UNSETTLED",
} as const;

/**
 * ME09 fix round 1 — the resume wrapper's run settlement gate, the resume
 * twin of the governed turn's own finish path (the `settlementClean()` check
 * before `runs.complete`). The engine finishing is never success on its own:
 * the governed carrier's settlement ledger is authoritative, and a drive the
 * lease cannot settle at all must not read as a resumed success either.
 *
 * - Clean settlement → `runs.complete` under the SAME lease; done.
 * - Completion refused → one truthful `runs.fail` under the same lease, then
 *   a named refusal (the run settled FAILED, never succeeded).
 * - Unverified settlement (refused/unknown usage, or no carrier surfaced) →
 *   `runs.fail` with the carrier-classified code, then a named refusal.
 * - Both settlements refused (a lease that expired mid-drive with nothing
 *   renewing it) → the lease is released, the run stays in its waiting
 *   status, and a named refusal isolates the outcome.
 *
 * Every path but the first throws, so the wrapper propagates a refusal
 * instead of reporting the continuation "resumed" — the continuation outcome
 * always reflects what actually happened to the run.
 */
export async function settleResumedRun(
  runs: Pick<RunService, "complete" | "fail" | "releaseRequestLease">,
  input: {
    scope: PlatformScope;
    lease: RunnerRequestLease;
    /** The surfaced governed carrier; null fails closed (no usage evidence). */
    carrier: Pick<
      GovernedModelExecution,
      "settlementClean" | "budgetExhausted" | "settlementFailed"
    > | null;
    outcome: "resumed" | "declined";
  },
): Promise<void> {
  const { scope, lease, carrier, outcome } = input;
  if (carrier?.settlementClean()) {
    const completed = await runs.complete(scope, { lease }).catch(() => false);
    if (completed) return;
    const settled = await runs
      .fail(scope, { lease, errorCode: "MODEL_EXECUTION_FAILED" })
      .catch(() => false);
    if (!settled) {
      await runs.releaseRequestLease(scope, lease).catch(() => undefined);
      throw new MastraContinuationRefusal(
        MASTRA_RESUME_SETTLE_REFUSALS.runUnsettled,
        `MASTRA_RESUME_RUN_UNSETTLED: the resumed drive finished (${outcome}) but the expired lease settled the run neither succeeded nor failed; the run stays waiting, the lease is released, and the resume is refused.`,
      );
    }
    throw new MastraContinuationRefusal(
      MASTRA_RESUME_SETTLE_REFUSALS.completionStale,
      `MASTRA_RESUME_COMPLETION_STALE: the resumed drive finished (${outcome}) but its completion was refused; the run settled FAILED (MODEL_EXECUTION_FAILED), never succeeded.`,
    );
  }
  const code = classifyGovernedRunFailure(carrier, undefined);
  const settled = await runs
    .fail(scope, { lease, errorCode: code })
    .catch(() => false);
  if (settled) {
    throw new MastraContinuationRefusal(
      MASTRA_RESUME_SETTLE_REFUSALS.settlementUnverified,
      `MASTRA_RESUME_SETTLEMENT_UNVERIFIED: the resumed drive finished (${outcome}) but its usage could not be verified; the run settled FAILED (${code}), never succeeded.`,
    );
  }
  await runs.releaseRequestLease(scope, lease).catch(() => undefined);
  throw new MastraContinuationRefusal(
    MASTRA_RESUME_SETTLE_REFUSALS.runUnsettled,
    `MASTRA_RESUME_RUN_UNSETTLED: the resumed drive finished (${outcome}) but the expired lease settled the run neither succeeded nor failed (${code}); the run stays waiting, the lease is released, and the resume is refused.`,
  );
}

/**
 * ME09 fix round 1 — the resume binding's currency check, extracted from the
 * production wiring so ONE definition serves the wiring and the tests: the
 * re-activated lease must be the SAME attempt/generation the continuation
 * binds, or the continuation's binding is stale and the resume refuses by
 * name before anything drives.
 */
export function assertResumeBindingCurrent(
  reactivated: { lease: { attemptId: string; generation: number } },
  binding: { attemptId: string; generation: number },
): void {
  if (
    reactivated.lease.attemptId !== binding.attemptId ||
    reactivated.lease.generation !== binding.generation
  ) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.generationStale,
      "MASTRA_CONTINUATION_GENERATION_STALE: the re-activated attempt is not the one the continuation binds.",
    );
  }
}

/**
 * The trusted scheduling record a firing re-reads at the moment of running.
 *
 * ME10: the record is each entry's OWN durable row (the routine row, the
 * responsibility run row, the delivery inbox row, the wake-up work item) —
 * the queue payload is a claim about it, never a substitute for it.
 * `frame` selects how the instruction becomes the turn's intent message: the
 * routine firing keeps its schedule-speak frame; an entry whose instruction
 * is already the person-visible message (a delivery inbound text, a wake-up
 * reason, a responsibility's composed goal turn) runs it UNFRAMED — the
 * frame is routine presentation, not a general contract.
 */
export interface GovernedSchedulingRecord {
  readonly agentId: string;
  readonly threadId: string;
  readonly instruction: string;
  readonly enabled: boolean;
  /** "firing" (the default, the routine frame) or "none" (raw instruction). */
  readonly frame?: "firing" | "none";
}

/** The Bot surfaces one governed turn runs with, assembled server-side. */
export interface GovernedTurnSurface {
  readonly instructions: readonly string[];
  readonly trailingInstructions?: readonly string[];
  readonly tools: readonly GrantedTool[];
  readonly learnedSkills?: LearnedSkillInvocationSurface;
  readonly personalMemoryContext?: string;
  readonly frontendTools?: readonly FrontendToolDefinition[];
  /**
   * The durable-continuation context (ME05/ME06) — present when the
   * deployment wired suspensions, so an approval wait saves its recovery
   * data BEFORE the waiting state is published.
   */
  readonly continuations?: ExecutionContinuationContext;
}

export interface GovernedTurnRunnerDeps {
  /**
   * The persistent scheduling record, read at the moment of running. Null
   * means the routine is gone; the queue payload never substitutes for it.
   */
  readonly schedulingRecordFor: (
    routineId: string,
  ) => Promise<GovernedSchedulingRecord | null>;
  /**
   * The trusted directory: the record's owner (a users-table id) plus the
   * record's thread resolve to the CURRENT scope — current memberships, the
   * conversation's own tenant/workspace/principal, entrypoint "schedule".
   * Revocation throws here and blocks the firing.
   */
  readonly scopeFor: (input: {
    ownerUserId: string;
    threadId: string;
  }) => Promise<PlatformScope>;
  readonly runs: Pick<
    RunService,
    | "start"
    | "acquireRequestLease"
    | "renewRequestLease"
    | "releaseRequestLease"
    | "complete"
    | "fail"
    | "cancel"
    | "markRunSuspended"
  >;
  readonly conversations: Pick<ConversationService, "append">;
  /**
   * The run event ledger, when the deployment wires one: every relayed event
   * is persisted under the exact admitted owner before it is consumed (the
   * same discipline the browser runner's relay applies). Absent keeps the
   * run row as the only ledger.
   */
  readonly events?: {
    append(
      scope: PlatformScope,
      input: {
        lease: RunnerRequestLease;
        sourceEventId: string;
        schemaVersion: number;
        event: BaseEvent;
      },
    ): Promise<unknown>;
  };
  readonly expertVersionFor: (input: {
    scope: PlatformScope;
    definition: ExpertDefinitionV1;
  }) => Promise<ExpertVersionRef>;
  /**
   * The server-side model selection for this Bot and thread: the admitted
   * route ref and the EXPLICIT ceiling (the route's own token cap). Null or
   * malformed → {@link GOVERNED_HEADLESS_REFUSALS.budgetUnconfigured}.
   */
  readonly modelRouteFor: (input: {
    scope: PlatformScope;
    agentId: string;
    threadId: string;
  }) => Promise<{ routeRef: string; maximumTokens: number } | null>;
  /**
   * The governed execution collaborator for this admission — the SAME
   * factory the browser runner builds its carrier from (route + ceiling +
   * capability minting + settlement ledger). Never a provider client.
   */
  readonly governedExecutionFor: (input: {
    scope: PlatformScope;
    agentId: string;
    routeRef: string;
    ceiling: number;
  }) => Promise<GovernedModelExecution> | GovernedModelExecution;
  /**
   * The Bot's trusted surfaces for this firing: prompt parts, granted tools,
   * learned skills, the personal-memory block and the durable-continuation
   * context — everything server-composed, nothing from the firing payload.
   */
  readonly surfaceFor: (input: {
    scope: PlatformScope;
    agentId: string;
    initiator: AuditInitiator;
    threadId: string;
    /**
     * The turn's own entry identity (the TurnRunner's routineId): ME10's
     * per-entry surfaces key their extra tools on it (the responsibility
     * engine's goal tools bind to the run the trail names). It is the SAME
     * value the intent key and the audit fallback derive from.
     */
    routineId: string;
    /**
     * The bound execution identity this turn runs under — the surface's
     * durable-continuation hook saves its suspension against the SAME
     * binding (the browser wiring composes the install with
     * `request.binding` the same way).
     */
    binding: ExecutionBinding;
  }) => Promise<GovernedTurnSurface>;
  readonly runtime: MastraConversationRuntime;
  /** See {@link DEFAULT_TURN_TIMEOUT_MS}. */
  readonly turnTimeoutMs?: number;
  /** See {@link DEFAULT_LEASE_RENEW_MS}. */
  readonly leaseRenewMs?: number;
}

/**
 * Is this error the runs service refusing a SECOND run for one submitted
 * message? That refusal IS the duplicate-delivery convergence: the intent
 * was already claimed by the first delivery.
 */
function isIntentConflict(error: unknown): boolean {
  return (
    error instanceof RunDomainError && error.code === "RUN_IDEMPOTENCY_CONFLICT"
  );
}

/**
 * Build the governed headless turn runner. The returned function satisfies
 * the exact `TurnRunner` contract `createRoutineRunner` consumes.
 */
export function createGovernedTurnRunner(
  deps: GovernedTurnRunnerDeps,
): TurnRunner {
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const leaseRenewMs = deps.leaseRenewMs ?? DEFAULT_LEASE_RENEW_MS;
  return async (input) => {
    if (input.signal?.aborted)
      throw new Error("The headless turn was cancelled.");
    const initiator: AuditInitiator = input.initiator ?? {
      kind: "routine" as const,
      id: input.routineId,
    };

    // AC1 — the scheduling record is the authority; the queue payload is a
    // claim about it, never a substitute for it. A firing whose caller
    // disagrees with the record is not this firing.
    const record = await deps.schedulingRecordFor(input.routineId);
    if (!record) {
      throw new GovernedHeadlessRefusal(
        GOVERNED_HEADLESS_REFUSALS.recordGone,
        "ROUTINE_SCHEDULING_RECORD_GONE: the routine behind this firing no longer exists.",
      );
    }
    if (!record.enabled) {
      throw new GovernedHeadlessRefusal(
        GOVERNED_HEADLESS_REFUSALS.recordGone,
        "ROUTINE_SCHEDULING_RECORD_GONE: the routine is switched off; a queued firing does not out-authorize the switch.",
      );
    }
    if (
      input.threadId !== record.threadId ||
      input.agentId !== record.agentId
    ) {
      throw new GovernedHeadlessRefusal(
        GOVERNED_HEADLESS_REFUSALS.contextMismatch,
        "ROUTINE_FIRING_CONTEXT_MISMATCH: the firing's thread/Bot disagree with the persistent scheduling record; a queue string is not an authorization.",
      );
    }

    // AC1 — the scope is re-issued from the directory, NOW: current
    // membership epochs, the conversation's own tenancy, entrypoint
    // "schedule". A revoked or deleted member throws here and the firing is
    // blocked with that real error before anything is admitted.
    const scope = await deps.scopeFor({
      ownerUserId: input.ownerUserId,
      threadId: record.threadId,
    });

    // AC2 — the explicit budget and the fixed payer. The ceiling is the
    // server-side route's own cap (never a queue field, never "unlimited");
    // the payer is the admitted scope's own principal, locked by the
    // admission's budget reservation.
    const route = await deps.modelRouteFor({
      scope,
      agentId: record.agentId,
      threadId: record.threadId,
    });
    if (
      !route ||
      typeof route.routeRef !== "string" ||
      !route.routeRef.trim() ||
      !isPositiveInt32TokenCount(route.maximumTokens)
    ) {
      throw new GovernedHeadlessRefusal(
        GOVERNED_HEADLESS_REFUSALS.budgetUnconfigured,
        "ROUTINE_BUDGET_UNCONFIGURED: no server-side model route with an explicit token ceiling resolved for this Bot; refusing instead of guessing a default company or an unlimited budget.",
      );
    }
    const ceiling = route.maximumTokens;

    // The ONE advance intent (AC3): derived from the routine and the firing
    // id (the durable delivery identity the queue offers under), never from
    // a tenant/owner string.
    const firingId = input.runId?.trim()
      ? input.runId.trim()
      : `manual-${crypto.randomUUID()}`;
    const clientMessageKey = governedFiringIntentKey(input.routineId, firingId);
    const content =
      record.frame === "none"
        ? record.instruction
        : frameFiring(record.instruction);
    const digest = messageDigest(content, []).digest;

    // The submitted message first (single-writer, idempotent on the intent
    // key), so the conversation-runtime rebuild can verify it as the newest
    // user row — the same order the browser runner uses.
    await deps.conversations.append(scope, {
      threadId: record.threadId,
      clientMessageKey,
      content,
      attachments: [],
    });

    const expertVersionRef = await deps.expertVersionFor({
      scope,
      definition: {
        schemaVersion: 1,
        agentId: record.agentId,
        source: "tenant_package",
        agentType: "built_in",
        systemPrompt: record.instruction,
        behaviorVersion: "openbot-routine-v1",
      },
    });
    const admission: TrustedRunAdmission = {
      input: {
        threadId: record.threadId,
        clientMessageKey,
        messageDigest: digest,
        attachmentRefs: [],
        entrypoint: scope.entrypoint,
        forwardedProps: { maxOutputTokens: ceiling },
      },
      agentId: record.agentId,
      expertVersionRef,
      routeRef: route.routeRef,
    };
    let run: Awaited<ReturnType<typeof deps.runs.start>>;
    try {
      run = await deps.runs.start(scope, admission);
    } catch (error) {
      if (isIntentConflict(error)) {
        // AC3/AC5 — a redelivery converges on the first advancement: the
        // admission refuses, so no second budget reservation exists to
        // charge the old run twice with.
        throw new GovernedHeadlessRefusal(
          GOVERNED_HEADLESS_REFUSALS.intentAlreadyAdvanced,
          "ROUTINE_INTENT_ALREADY_ADVANCED: this firing's advance intent was already claimed; a redelivery does not run it twice.",
        );
      }
      throw error;
    }

    let lease: RunnerRequestLease;
    try {
      lease = await deps.runs.acquireRequestLease(scope, run.run_id);
    } catch (cause) {
      await deps.runs
        .cancel(scope, { runId: run.run_id, reason: "timeout" })
        .catch(() => undefined);
      throw cause;
    }

    // Declared before any settleFailure call below: settleFailure's first line stops the
    // renewal, and a call before this point would hit the binding while it is still in its
    // temporal dead zone and turn the real failure into a ReferenceError.
    let renewalTimer: ReturnType<typeof setInterval> | undefined;
    const stopRenewal = () => {
      if (renewalTimer === undefined) return;
      clearInterval(renewalTimer);
      renewalTimer = undefined;
    };
    const carrier = await deps.governedExecutionFor({
      scope,
      agentId: record.agentId,
      routeRef: route.routeRef,
      ceiling,
    });
    carrier.bind({
      runId: run.run_id,
      attemptId: lease.attemptId,
      generation: lease.generation,
    });
    const facts = carrier.governedModel.executionBinding?.();
    if (!facts) {
      await settleFailure("MODEL_EXECUTION_FAILED");
      throw new Error("GOVERNED_EXECUTION_UNBOUND");
    }

    // The live-lease probe (AC6): composed from the runner's own fencing —
    // every renewal answer is the runs service' verdict on this lease. After
    // a loss, the tools' guard blocks every NEW external call.
    let leaseLost = false;
    const renew = async (): Promise<boolean> => {
      try {
        lease = await deps.runs.renewRequestLease(scope, lease);
        return true;
      } catch {
        return false;
      }
    };
    renewalTimer = setInterval(() => {
      void renew().then((current) => {
        if (current || renewalTimer === undefined) return;
        leaseLost = true;
        stopRenewal();
        abort.abort();
      });
    }, leaseRenewMs);
    renewalTimer.unref?.();

    const abort = new AbortController();
    const onAbort = () => {
      abort.abort();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    /** The lease goes back on every exit path (the browser runner's
     * finalize discipline); released exactly once per turn. */
    let leaseReleased = false;
    const releaseLease = () => {
      if (leaseReleased) return;
      leaseReleased = true;
      void deps.runs.releaseRequestLease(scope, lease).catch(() => undefined);
    };

    /** The assistant texts the turn produced, in persisted order. */
    const assistantTextsOf = (
      messages: readonly { role: string; content?: unknown }[],
    ): string[] => {
      const said: string[] = [];
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        if (typeof message.content === "string" && message.content.length > 0)
          said.push(message.content);
      }
      return said;
    };

    /** Settled-once guard: the store's terminal transition is finish-once;
     * this keeps the runner from even asking twice. */
    let failureSettled = false;
    async function settleFailure(code: RunFailureCode): Promise<boolean> {
      stopRenewal();
      if (failureSettled) return true;
      const settled = await deps.runs
        .fail(scope, { lease, errorCode: code })
        .catch(() => false);
      if (!settled)
        await deps.runs
          .cancel(scope, { runId: run.run_id, reason: "timeout" })
          .catch(() => undefined);
      else failureSettled = true;
      return settled;
    }

    try {
      // The model context is the server's persisted history (AC4): the
      // submitted intent message is already appended, so the rebuild verifies
      // it as the newest user row and hands the engine the authorized
      // transcript — never the firing payload's version of it.
      const rebuilt = await deps.runtime.loadExecutionInput(scope, {
        threadId: record.threadId,
        runId: run.run_id,
        messages: [{ id: clientMessageKey, role: "user", content }],
        tools: [],
        context: [],
        forwardedProps: {},
      });
      const binding: ExecutionBinding = {
        ...facts,
        threadId: rebuilt.threadId,
      };
      // The Bot surfaces resolve with the bound identity, so a durable
      // suspension's save hook can write its continuation against the SAME
      // binding the run executes under (the browser wiring composes the
      // install with request.binding the same way).
      const surface = await deps.surfaceFor({
        scope,
        agentId: record.agentId,
        initiator,
        threadId: record.threadId,
        routineId: input.routineId,
        binding,
      });
      const collector = createProducedMessageCollector();
      let terminal: BaseEvent | undefined;
      let streamFailure: unknown;
      let failureEventCode: RunFailureCode | undefined;
      let suspension:
        | {
            kind: "approval" | "question" | "frontend_tool";
            toolName: string;
            toolCallId: string;
          }
        | undefined;
      const eventsDone = new Promise<void>((resolve) => {
        executeGovernedMastra({
          binding,
          input: rebuilt,
          instructions: surface.instructions,
          ...(surface.trailingInstructions
            ? { trailingInstructions: surface.trailingInstructions }
            : {}),
          tools: surface.tools,
          // F4 (ME10): the unattended turn's approval binding — an approval
          // ask raised inside a granted execute opens its approvals-subsystem
          // request against THIS run (run id, thread, initiator), so the
          // decision resumes the exact parked continuation instead of
          // refusing an ask "not started from a conversation".
          approvalBinding: {
            runId: binding.runId,
            threadId: binding.threadId ?? "",
            initiator,
          },
          ...(surface.learnedSkills
            ? { learnedSkills: surface.learnedSkills }
            : {}),
          ...(surface.frontendTools && surface.frontendTools.length > 0
            ? { frontendTools: surface.frontendTools }
            : {}),
          ...(surface.personalMemoryContext
            ? { personalMemoryContext: surface.personalMemoryContext }
            : {}),
          ...(surface.continuations
            ? {
                continuations: {
                  ...surface.continuations,
                  // Observe the durable suspension the wiring saved, so the
                  // waiting outcome can name it (AC5: the approval wait is
                  // persisted, never read as a success or a vendor error).
                  onSuspension: async (fact) => {
                    suspension = {
                      kind: fact.kind,
                      toolName: fact.toolName,
                      toolCallId: fact.toolCallId,
                    };
                    await surface.continuations?.onSuspension(fact);
                  },
                },
              }
            : {}),
          // AC6 — the tools' guard probes the live lease before every NEW
          // external call; a lost lease blocks the next one by name.
          leaseCurrent: async () => {
            if (leaseLost) return false;
            return renew();
          },
          governedModel: carrier.governedModel,
          signal: abort.signal,
        }).subscribe({
          next: (event) => {
            if (event.type === "RUN_FINISHED") {
              terminal = event;
              return;
            }
            if (event.type === "RUN_ERROR") {
              failureEventCode = classifyGovernedRunFailure(carrier, event);
            }
            collector.push(event);
            void deps.events
              ?.append(scope, {
                lease,
                sourceEventId: crypto.randomUUID(),
                schemaVersion: 1,
                event,
              })
              .catch((cause: unknown) => {
                // BEST-EFFORT by contract (ME09 report §4, F5): the headless
                // turn has no live subscriber to stream a failure to, so a
                // refused event append is logged and the turn continues. The
                // settlement evidence a reader answers to is the run row, the
                // conversation write-back and the capability ledger — all of
                // which are store-committed, not ledger-mediated. This is a
                // declared divergence from the browser relay (whose append
                // failure fails the run); upgrading headless to fail-run is
                // deferred until a consumer needs the event ledger.
                log.error(
                  {
                    type: "routine-run-event-append-failed",
                    runId: run.run_id,
                    reason:
                      cause instanceof Error
                        ? cause.message
                        : String(cause ?? ""),
                  },
                  "routine-run-event-append-failed",
                );
              });
          },
          error: (cause) => {
            streamFailure = cause;
            resolve();
          },
          complete: () => resolve(),
        });
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        const deadline = setTimeout(() => {
          abort.abort();
          reject(
            new Error(
              `The routine's governed turn did not finish within ${Math.round(turnTimeoutMs / 1000)}s.`,
            ),
          );
        }, turnTimeoutMs);
        deadline.unref?.();
      });
      await Promise.race([eventsDone, timeout]);
      stopRenewal();

      if (streamFailure !== undefined) {
        const code = classifyGovernedRunFailure(carrier, streamFailure);
        await settleFailure(code);
        throw streamFailure;
      }
      if (terminal !== undefined) {
        // Success requires verified usage settlement (the browser relay's
        // rule): a clean-looking finish without confirmed usage fails the
        // run with the classified code instead of succeeding.
        if (!carrier.settlementClean()) {
          const code = classifyGovernedRunFailure(carrier, undefined);
          await settleFailure(code);
          throw new Error(
            `MODEL_SETTLEMENT_UNVERIFIED: the governed turn finished but its usage could not be verified (${code}).`,
          );
        }
        // Write-back BEFORE completion (AC5): the produced messages are in
        // the conversation store before the run settles, so a refresh shows
        // the answer even as the completion publishes.
        await deps.runtime.persistExecutionMessages(
          binding,
          collector.snapshot(),
        );
        const completed = await deps.runs
          .complete(scope, { lease })
          .catch(() => false);
        if (!completed) {
          const settled = await deps.runs
            .fail(scope, { lease, errorCode: "MODEL_EXECUTION_FAILED" })
            .catch(() => false);
          if (!settled)
            await deps.runs
              .cancel(scope, { runId: run.run_id, reason: "timeout" })
              .catch(() => undefined);
          throw new Error("RUN_COMPLETION_SETTLEMENT_STALE");
        }
        const replyText = assistantTextsOf(collector.snapshot()).join("\n\n");
        const result: { replyText: string } = { replyText };
        return result;
      }
      if (failureEventCode !== undefined) {
        // The stream carried a RUN_ERROR terminal: classify, settle, fail.
        await settleFailure(failureEventCode);
        throw new Error(
          `ROUTINE_TURN_RUN_ERROR: the governed turn failed (${failureEventCode}).`,
        );
      }
      if (suspension) {
        // AC5 — the approval/participation wait: the continuation is already
        // saved (the wiring's hook ran before this point), so the run moves
        // to its ACTIVE waiting status and the firing records a waiting
        // outcome — never a success, never a vendor error.
        const marked = await deps.runs
          .markRunSuspended(scope, {
            lease,
            status:
              suspension.kind === "approval" ? "waiting_approval" : "suspended",
          })
          .catch(() => false);
        if (!marked) {
          await settleFailure("MODEL_EXECUTION_FAILED");
          throw new Error(
            "RUN_SUSPENSION_SETTLEMENT_STALE: the engine paused but the run could not be parked as waiting.",
          );
        }
        // The lease goes back so the later decision's drive can re-arm it
        // (the re-activation refuses a live request owner).
        releaseLease();
        throw new HeadlessToolSuspension(
          `The turn is waiting for human input (${suspension.kind}: ${suspension.toolName}).`,
          {
            kind: suspension.kind,
            toolName: suspension.toolName,
            requestId: suspension.toolCallId,
          },
        );
      }
      // Terminal-less without a suspension fact: nothing proved what
      // happened — fail truthfully instead of inventing an outcome.
      await settleFailure("MODEL_EXECUTION_FAILED");
      throw new Error(
        "ROUTINE_TURN_UNTERMINATED: the governed turn ended without a terminal or a saved suspension.",
      );
    } catch (cause) {
      if (cause instanceof GovernedHeadlessRefusal) throw cause;
      if (cause instanceof HeadlessToolSuspension) throw cause;
      if (!isIntentConflict(cause)) {
        // A failure whose run has not settled yet (a throw before the stream
        // even started — an unwired runtime, a refused rebuild) still
        // terminalizes truthfully; settleFailure is finish-once-safe because
        // the store's transition only matches an unsettled run.
        await settleFailure("MODEL_EXECUTION_FAILED").catch(() => false);
      }
      throw cause;
    } finally {
      stopRenewal();
      releaseLease();
      input.signal?.removeEventListener("abort", onAbort);
    }
  };
}
