import type { PlatformScope } from "../enterprise/contracts";
import {
  // The idempotent-decision derivation is a shared contract surface (the
  // already_applied check here and the store's claim record must never
  // diverge): consumed from its one definition, never re-copied.
  decisionIdOf,
  MASTRA_CONTINUATION_REFUSALS,
  type MastraContinuationRecord,
  MastraContinuationRefusal,
  type MastraContinuationStore,
  type MastraOperationIdentity,
} from "./continuation-store";
import type {
  ClaimedContinuation,
  ExecutionBinding,
  MastraSuspensionFact,
  ResumeDecision,
  ResumeRef,
} from "./execution-contracts";

/*
 * ME05 (#477) T6: accurate recovery — the layer that consumes an EXISTING
 * approvals-subsystem decision (deny/expire/revoke semantics stay the product
 * authority; nothing here re-decides) and drives the pinned Mastra resume.
 *
 * Every resume re-verifies, in order, before anything executes:
 *   identity (the resumer IS the suspended scope's person, field-wise),
 *   → current ownership (the optional lease probe; T8/T9 slot in without a
 *     signature change),
 *   → generation currency,
 *   → decision/payload compatibility and the exact argument digest (a
 *     tampered digest refuses),
 *   → engine fingerprint compatibility (an incompatible snapshot isolates,
 *     never deserializes-and-guesses),
 *   → the tool grant is still valid (a revoked source blocks),
 * and only then takes the single CAS claim and drives the engine against the
 * STORED runId. Completed receipts are REUSED, never re-executed; an external
 * effect whose outcome cannot be proven ends pending_unknown — user-visible
 * 待处置, never auto-replayed.
 */

/** What one resume drive returns to the caller. */
export type MastraContinuationResumeResult =
  | {
      readonly kind: "resumed";
      /** The produced answer text, when the drive reports it. */
      readonly answer?: string;
      /** The engine finish reason, when the drive reports it. */
      readonly finishReason?: string;
    }
  | {
      readonly kind: "declined";
      readonly answer?: string;
      readonly finishReason?: string;
    }
  | {
      /**
       * R3-11: the resumed run paused AGAIN on a durable call. The
       * replacement continuation is already saved (the wired hook); the
       * original row's claim was released back to waiting, its receipt was
       * never upgraded, and nothing reads as "resumed".
       */
      readonly kind: "re_suspended";
      readonly answer?: string;
      readonly finishReason?: string;
    }
  | { readonly kind: "reused_receipt"; readonly receiptId: string }
  | { readonly kind: "pending_unknown"; readonly continuationId: string }
  | { readonly kind: "already_applied" };

/**
 * The receipt-evidence sink one drive writes through: `started` records the
 * operation with outcome unknown BEFORE the engine can reach the external
 * call, `executed` upgrades it once the result is confirmed. Crash windows
 * leave `unknown` — which recovery refuses to replay.
 *
 * `started` is ALSO the claim fence (F1): it refuses with
 * `MASTRA_CONTINUATION_CLAIM_LOST` when the receipt already exists — another
 * driver took the claim and recorded the operation — so a drive that awaits
 * `started` before any engine call can never double-drive a taken-over run.
 */
export interface MastraResumeReceiptSink {
  started(): Promise<void>;
  executed(): Promise<string | null>;
}

/**
 * What one drive returns. The bare string form is the minimum contract (the
 * CAS finish outcome); a production drive MAY return the produced facts —
 * the resumed loop's answer text and finish reason — so the approvals
 * consumer can surface what the user's decision actually produced.
 * `re_suspended` (R3-11): the drive paused again on a durable call; the
 * replacement continuation is saved through the drive input's onSuspension
 * hook and the orchestrator keeps the row waiting.
 */
export type MastraResumeDrive =
  | "resumed"
  | "declined"
  | "re_suspended"
  | {
      readonly outcome: "resumed" | "declined" | "re_suspended";
      readonly answer?: string;
      readonly finishReason?: string;
    };

/** The re-suspension fact a drive reports through its save hook (R3-11). */
export interface MastraDriveSuspensionFact {
  /** ME06: which continuation kind the replacement pause saves as. */
  readonly kind: "approval" | "frontend_tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
}

/** The engine-facing resume drive; `createMastraResumeDriver` is the production implementation. */
export interface MastraResumeDriver {
  resume(input: {
    claim: ClaimedContinuation;
    decision: ResumeDecision;
    receiptSink: MastraResumeReceiptSink;
    /**
     * R3-11: the per-drive re-suspension save hook. The orchestrator wires
     * the store's convergent save here; a drive that pauses again MUST have
     * it (or a driver-deps-level hook) before durable tools are mounted.
     */
    onSuspension?: (fact: MastraDriveSuspensionFact) => Promise<void>;
    /**
     * ME10: the CALLER'S current trusted scope — the scope this resume was
     * authorized under (the orchestrator has already verified it field-wise
     * against the re-derived binding). A store record's binding scope is a
     * re-derivation, not a trust artifact: the runs-service faces the drive
     * wrapper calls (re-activation, renewal, settlement) answer only to a
     * scope the resolver issued in THIS process, so the orchestrator hands
     * the caller's scope through instead of letting the wrapper reuse the
     * untrusted one.
     */
    scope: PlatformScope;
  }): Promise<MastraResumeDrive>;
}

export interface ResumeMastraContinuationDeps {
  readonly store: MastraContinuationStore;
  /** The CURRENT engine fingerprint; defaults to the store's. */
  readonly currentFingerprint?: string;
  /** Is the tool grant this call rode on still valid NOW? */
  readonly toolGrantCurrent: (input: {
    scope: PlatformScope;
    botId: string;
    toolName: string;
    /**
     * ME09 (#481): the suspension KIND the pending call saved as. An
     * `approval` wait checks the plugin grant ledger; a `frontend_tool` wait
     * checks the participation surface's own revocable authority. Absent on
     * pre-ME09 assemblies (treated as `approval`).
     */
    kind?: "approval" | "question" | "frontend_tool";
    /**
     * PKG09 (Spec §9): the continuation's OWN bound run and attempt. A
     * package tool's grant is its run's pin set at that attempt, so the grant
     * re-check needs the run identity to find the tool at all; without it a
     * `pkg:` call can never match and every package approval would refuse as
     * `MASTRA_CONTINUATION_GRANT_REVOKED`. Absent on assemblies that do not
     * serve package tools (the legacy grant check ignores it).
     */
    boundRun?: {
      readonly runId: string;
      readonly attemptGeneration: number;
    };
  }) => Promise<boolean>;
  /** Is the run's generation still the one the continuation binds? */
  readonly generationCurrent: (input: {
    scope: PlatformScope;
    runId: string;
    /** ME06 (production assembly): the bound attempt, for the runs
     * service's active-attempt probe (a stopped run's generation moves). */
    attemptId?: string;
    generation: number;
  }) => Promise<boolean>;
  /**
   * Current-ownership probe (the runner's lease fencing). Optional TODAY so
   * the T8/T9 injection slots in without a signature change; a failed probe
   * refuses exactly as a stale generation does.
   */
  readonly leaseCurrent?: () => boolean | Promise<boolean>;
  readonly driver: MastraResumeDriver;
}

/**
 * Resume one durable continuation with an authenticated decision.
 *
 * Idempotent on the decision id: re-applying a decision that already finished
 * this continuation is `already_applied`, never a second run. A crash after
 * the claim but before the drive leaves the claim to expire, and the re-apply
 * is governed by receipt evidence (nothing recorded → safe to drive once;
 * started-unknown → 待处置; executed → reuse).
 */
export async function resumeMastraContinuation(
  deps: ResumeMastraContinuationDeps,
  input: {
    scope: PlatformScope;
    ref: ResumeRef;
    decision: ResumeDecision;
  },
): Promise<MastraContinuationResumeResult> {
  const { scope, ref, decision } = input;
  const record = await deps.store.getContinuation(scope, ref.continuationId);
  if (
    !record ||
    // Field-wise identity: another person's (or another tenant's) continuation
    // reads as absence — never "exists but not yours".
    !scopeIdentityMatches(scope, record.binding)
  ) {
    throw new MastraContinuationRefusal(MASTRA_CONTINUATION_REFUSALS.notFound);
  }
  // Idempotent re-apply: this exact decision already finished the row.
  if (
    record.status === "finished" &&
    record.decisionId === decisionIdOf(decision)
  ) {
    return { kind: "already_applied" };
  }
  // Current ownership first: the optional lease probe (T8/T9 slot-in) and the
  // generation currency fail the same way — a stale owner resumes nothing.
  if (deps.leaseCurrent && !(await deps.leaseCurrent())) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.generationStale,
      "MASTRA_CONTINUATION_GENERATION_STALE: the run's lease/owner is no longer current.",
    );
  }
  if (
    !(await deps.generationCurrent({
      scope,
      runId: record.binding.runId,
      // ME06: the bound attempt rides along so the production gate can ask
      // the runs service whether THIS attempt is still its run's active one.
      attemptId: record.binding.attemptId,
      generation: record.binding.generation,
    }))
  ) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.generationStale,
    );
  }
  // Compatibility BEFORE evidence: an engine fingerprint that no longer
  // matches isolates the continuation — refused, untouched, never executed
  // and never deserialized as a guess.
  const currentFingerprint =
    deps.currentFingerprint ?? deps.store.currentFingerprint();
  if (record.payload.packageFingerprint !== currentFingerprint) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.fingerprintIncompatible,
    );
  }
  // The source's authority is re-checked NOW: a grant revoked since the
  // suspension blocks the resume (the product's own revoke semantics stay
  // authoritative; this is the continuation-layer enforcement).
  if (
    !(await deps.toolGrantCurrent({
      scope,
      botId: record.binding.botId,
      toolName: record.payload.toolName,
      // ME09: kind-aware re-verification — the gate the decision faces is
      // the one that granted the KIND of call that is waiting.
      kind: record.payload.kind,
      // PKG09: the parked continuation's own run/attempt, from the record
      // the claim was taken on — the same identity the six gates below
      // re-verify, never a current-run guess.
      boundRun: {
        runId: record.binding.runId,
        attemptGeneration: record.binding.generation,
      },
    }))
  ) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.grantRevoked,
    );
  }
  // Tamper gate before any claim: an approved decision naming different
  // arguments than the pending call refuses outright.
  if (
    decision.kind === "approved" &&
    decision.argsDigest !== record.payload.argsDigest
  ) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.argsMismatch,
    );
  }
  // Receipt evidence FIRST for a stale claim: what an expired claim may do is
  // decided by what provably happened to the external effect — never by a
  // retry heuristic.
  const receipt = await deps.store.findReceipt(scope, record.operationId);
  if (receipt) {
    if (receipt.status === "executed") {
      return finishWithReuse(deps, record, receipt.receiptId);
    }
    return finishPendingUnknown(deps, record);
  }
  // Single winner: the CAS claim. Concurrent resumers (clicks, webhooks,
  // instances) lose here with a named conflict, not a second execution. The
  // claim rides the JUST-READ record's revision — the caller's ref identifies
  // the continuation, the fresh read carries the current CAS revision. F5:
  // the caller-supplied `ref.revision` is therefore advisory only; currency
  // is re-established by this fresh read plus the store-side CAS, and the
  // drive itself is fenced by the receipt sink's store-side verdict below —
  // never by the caller's revision.
  const claim = await deps.store.claimContinuation(scope, record.ref, decision);
  const operation: MastraOperationIdentity = {
    operationId: record.operationId,
    runId: record.binding.runId,
    toolCallId: record.payload.toolCallId,
    toolName: record.payload.toolName,
    argsDigest: record.payload.argsDigest,
  };
  const receiptSink: MastraResumeReceiptSink = {
    started: async () => {
      // THE CLAIM FENCE (F1): `started` records the receipt outcome-unknown
      // and reports whether THIS drive recorded it. A `started: false` means
      // a takeover's driver already recorded the operation — this driver
      // lost its claim while stalled and must refuse here, before any
      // engine drive, or two drivers would race the same suspended run.
      const recorded = await deps.store.recordOperationStarted(
        scope,
        operation,
      );
      if (!recorded.started) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.claimLost,
          `MASTRA_CONTINUATION_CLAIM_LOST: the receipt for this operation already exists (${recorded.status}); this driver's claim was taken over and it may not drive the engine.`,
        );
      }
    },
    executed: () =>
      deps.store.recordOperationExecuted(scope, operation.operationId),
  };
  // The drive's own failure propagates as-is: the claim it won is left to
  // expire, and the re-apply is governed by receipt evidence. Nothing is
  // auto-retried inside this function.
  const driven = await deps.driver.resume({
    claim,
    decision,
    receiptSink,
    // ME10: the caller's trusted scope rides to the drive wrapper.
    scope,
    // R3-11: THE re-suspension wiring — the store's convergent save, bound
    // to the claimed binding and the CURRENT fingerprint (the engine that
    // persisted the replacement snapshot is this one). The replacement
    // continuation therefore exists before any waiting state is published
    // again; the driver refuses to mount durable tools without a hook, and
    // this supply is what keeps that gate open on the orchestrated path.
    onSuspension: async (fact) => {
      await deps.store.saveContinuation(claim.binding, {
        schemaVersion: 1,
        engine: "mastra",
        // ME06: the replacement pause saves as ITS OWN kind — an approval
        // re-pause stays an approval, a frontend re-pause stays a
        // frontend_tool — so the resumed row's decision shape always
        // matches what the client can actually supply next.
        kind: fact.kind,
        packageFingerprint: currentFingerprint,
        toolCallId: fact.toolCallId,
        toolName: fact.toolName,
        argsDigest: fact.argsDigest,
        snapshotRef: `suspended:${claim.binding.executionKey}:${fact.toolCallId}`,
      });
    },
  });
  const outcome = typeof driven === "string" ? driven : driven.outcome;
  if (outcome === "re_suspended") {
    // R3-11: the drive paused again on a NEW durable call. This row is NOT
    // finished — it published no outcome worth a terminal — so its claim is
    // released back to waiting (the receipt keeps its started-unknown
    // evidence, which is what governs any later re-apply of THIS row), and
    // the caller reads a distinct re_suspended result, never "resumed".
    await deps.store.releaseClaim(claim);
    return { kind: "re_suspended", ...producedFactsOf(driven) };
  }
  await deps.store.finishContinuation(claim, outcome);
  const produced = producedFactsOf(driven);
  return outcome === "declined"
    ? { kind: "declined", ...produced }
    : { kind: "resumed", ...produced };
}

/** The produced answer/finish-reason facts a rich drive result carries. */
function producedFactsOf(driven: MastraResumeDrive): {
  answer?: string;
  finishReason?: string;
} {
  if (typeof driven === "string") return {};
  const facts: { answer?: string; finishReason?: string } = {};
  if (driven.answer !== undefined) facts.answer = driven.answer;
  if (driven.finishReason !== undefined)
    facts.finishReason = driven.finishReason;
  return facts;
}

async function finishWithReuse(
  deps: ResumeMastraContinuationDeps,
  record: MastraContinuationRecord,
  receiptId: string,
): Promise<MastraContinuationResumeResult> {
  const claim = await deps.store.claimForReceiptEvidence(
    record.binding.scope,
    record.ref,
    `receipt-checkpoint:${record.operationId}`,
  );
  await deps.store.finishContinuation(claim, "resumed");
  return { kind: "reused_receipt", receiptId };
}

async function finishPendingUnknown(
  deps: ResumeMastraContinuationDeps,
  record: MastraContinuationRecord,
): Promise<MastraContinuationResumeResult> {
  const claim = await deps.store.claimForReceiptEvidence(
    record.binding.scope,
    record.ref,
    `receipt-checkpoint:${record.operationId}`,
  );
  // The external effect may have landed but cannot be proven: the
  // continuation ends failed_unknown — the user-visible 待处置 state. It is
  // NEVER auto-replayed, by this process or a future one.
  await deps.store.finishContinuation(claim, "failed_unknown");
  return { kind: "pending_unknown", continuationId: record.ref.continuationId };
}

function scopeIdentityMatches(
  scope: PlatformScope,
  binding: { scope: PlatformScope },
): boolean {
  return (
    scope.tenantId === binding.scope.tenantId &&
    scope.workspaceId === binding.scope.workspaceId &&
    scope.principalId === binding.scope.principalId &&
    scope.actorId === binding.scope.actorId
  );
}

/**
 * The server-assembled install the execution and resume seams consume (the
 * copilot assembly installs it; a test assembly installs its own). Everything
 * server-owned flows through here: which engine storage snapshots persist
 * into, which tool names mount the durable approval pause, and the save +
 * resume entry — the client can never supply any of it.
 */
export interface MastraContinuationInstall {
  /** The tenant-restricted engine storage one binding's snapshots live in. */
  storageFor(binding: ExecutionBinding): unknown | undefined;
  /** The granted tool names mounted with the durable approval pause. */
  readonly durableToolNames: readonly string[];
  /** Save one suspension's continuation (BEFORE any waiting publication). */
  saveSuspension(
    binding: ExecutionBinding,
    suspension: MastraSuspensionFact,
  ): Promise<ResumeRef>;
  /** The accurate-resume entry an approval decision consumes. */
  resume(input: {
    scope: PlatformScope;
    ref: ResumeRef;
    decision: ResumeDecision;
  }): Promise<MastraContinuationResumeResult>;
}

export function createMastraContinuationInstall(deps: {
  store: MastraContinuationStore;
  currentFingerprint?: string;
  storageFor(binding: ExecutionBinding): unknown | undefined;
  readonly durableToolNames?: readonly string[];
  toolGrantCurrent: (input: {
    scope: PlatformScope;
    botId: string;
    toolName: string;
    kind?: "approval" | "question" | "frontend_tool";
    /** PKG09: the continuation's own run/attempt (see `ResumeMastraContinuationDeps`). */
    boundRun?: {
      readonly runId: string;
      readonly attemptGeneration: number;
    };
  }) => Promise<boolean>;
  generationCurrent: (input: {
    scope: PlatformScope;
    runId: string;
    attemptId?: string;
    generation: number;
  }) => Promise<boolean>;
  leaseCurrent?: () => boolean | Promise<boolean>;
  driver: MastraResumeDriver;
}): MastraContinuationInstall {
  return {
    storageFor: (binding) => deps.storageFor(binding),
    durableToolNames: deps.durableToolNames ?? [],
    saveSuspension: (binding, suspension) =>
      deps.store.saveContinuation(
        binding,
        {
          schemaVersion: 1,
          engine: "mastra",
          kind: suspension.kind,
          packageFingerprint:
            deps.currentFingerprint ?? deps.store.currentFingerprint(),
          toolCallId: suspension.toolCallId,
          toolName: suspension.toolName,
          argsDigest: suspension.argsDigest,
          snapshotRef: suspension.snapshotRef,
        },
        // F6: the fact's own operationId is consumed — the store asserts it
        // equals its derivation, so the execution-side and store-side
        // formulas cannot drift silently.
        suspension.operationId,
      ),
    resume: (input) =>
      resumeMastraContinuation(
        {
          store: deps.store,
          ...(deps.currentFingerprint
            ? { currentFingerprint: deps.currentFingerprint }
            : {}),
          toolGrantCurrent: deps.toolGrantCurrent,
          generationCurrent: deps.generationCurrent,
          ...(deps.leaseCurrent ? { leaseCurrent: deps.leaseCurrent } : {}),
          driver: deps.driver,
        },
        input,
      ),
  };
}

export { MASTRA_CONTINUATION_REFUSALS, MastraContinuationRefusal };
