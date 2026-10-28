import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import type {
  MastraDriveSuspensionFact,
  MastraResumeDrive,
  MastraResumeDriver,
} from "./approvals";
import {
  MASTRA_CONTINUATION_REFUSALS,
  MastraContinuationRefusal,
} from "./continuation-store";
import { mastraLoopModel, TOOL_LOOP_MAX_STEPS } from "./execution";
import type {
  ClaimedContinuation,
  ExecutionBinding,
} from "./execution-contracts";
import { buildInstructions } from "./instructions";
import { argsDigestFor } from "./tools";

/*
 * ME05 (#477) fix-round-1: the PRODUCTION resume driver — the engine-facing
 * half of `resumeMastraContinuation`. It runs ONLY after the orchestrator's
 * six gates and the single CAS claim succeeded, and drives the pinned Mastra
 * resume surface against the STORED run id:
 *
 *   approved → `receiptSink.started()` BEFORE the resume can reach the
 *              external call, then `agent.resumeStream({ approved: true },
 *              { runId, toolCallId })`, then `receiptSink.executed()`;
 *   declined → `agent.declineToolCall({ runId, toolCallId, reason })`, with
 *              NO receipt (a declined call never executes, so there is no
 *              external effect to record — started/executed must not exist).
 *
 *   R3-11: an approved drive whose stream ENDS SUSPENDED AGAIN reports the
 *   distinct `re_suspended` outcome — the replacement continuation is saved
 *   through the wired onSuspension hook, the receipt is never upgraded, and
 *   the orchestrator releases this row back to waiting (never "resumed").
 *
 * The durable stack shape is the ME01-proven one: a storage-backed Mastra
 * instance owning an agent with the SAME agent id the suspension was written
 * under, the granted tools mounted with the engine-level `requireApproval`
 * pause, and the SAME loop cap and model wrapper the original execution ran.
 *
 * What this file deliberately does NOT own: resolving WHICH PostgresStore is
 * the run's tenant storage, and resolving the granted model/tools for the
 * bot. Both are product-assembly concerns (the tenant-storage registry
 * lookup, the governed-model and grant surfaces) that the approvals-integration
 * slice binds when it installs the continuation wiring; here they arrive as
 * injected factories. Missing storage or a non-approval payload refuses with
 * a named code — nothing is guessed.
 */

/** The granted loop surface one resumed engine run executes with. */
export interface MastraResumeLoop {
  /** The engine loop's model (production: the governed collaborator's). */
  readonly model: unknown;
  /** The granted tools mounted for the resumed run (the controlled wrapper's surface). */
  readonly tools?: Record<string, unknown>;
  /** The trusted instruction parts the original run carried. */
  readonly instructions?: readonly string[];
  /**
   * The parts legacy composes AFTER the unconditional guidance blocks (the
   * granted-tool paragraph); with `instructions` this reproduces the original
   * run's exact legacy sequence.
   */
  readonly trailingInstructions?: readonly string[];
  /** The agent identity the suspension was written under; defaults to `openbot-<botId>`. */
  readonly agentId?: string;
  /** Tool names mounted with the durable approval pause. */
  readonly durableToolNames?: readonly string[];
  /** The loop cap; defaults to the execution path's own (`TOOL_LOOP_MAX_STEPS`). */
  readonly maxSteps?: number;
  /**
   * ME10: the run's OWN admitted ceiling, set on every resumed model call —
   * the same modelSettings the governed execution path streams with. The
   * governed gateway adapter fail-closes a call without an explicit positive
   * token ceiling, so a resumed loop assembled without this can never dial.
   */
  readonly maxOutputTokens?: number;
}

export interface CreateMastraResumeDriverDeps {
  /**
   * The tenant-restricted engine storage the suspended snapshot lives in —
   * injected, not looked up here: resolving the run's storage from the
   * tenant-storage registry (the ME03 `TenantMastraStorage` path) is the
   * approvals-integration slice's assembly, which supplies this factory.
   * Absent storage isolates the continuation (`storageMissing`) — the driver
   * never resumes from a guessed stack.
   */
  readonly storageFor: (
    binding: ExecutionBinding,
  ) => Promise<unknown> | unknown;
  /**
   * The granted loop surface the resumed run executes with, re-resolved
   * server-side at resume time. The orchestrator has already re-verified the
   * tool grant; this mounts the granted surface — never a client-supplied one.
   */
  readonly loopFor: (
    claim: ClaimedContinuation,
  ) => Promise<MastraResumeLoop> | MastraResumeLoop;
  /**
   * Streaming consumer for the events the resumed loop produces (the
   * approvals route may relay them into the conversation). Optional; the
   * drive's returned `answer`/`finishReason` carry the produced facts either way.
   */
  readonly onEvent?: (event: unknown) => void;
  /**
   * OCR fix wave 3 (R3-11): the re-suspension save hook. When a resumed run
   * pauses AGAIN on a durable call, the engine has already persisted the
   * replacement snapshot (the durable stack below owns that storage); this
   * hook persists the matching OpenBot continuation, so "engine waiting, no
   * recovery data" can never exist. The six-gate orchestrator wires the
   * store's convergent save here per drive; a driver constructed without it
   * refuses to mount durable tools (fail-closed), and the orchestrator always
   * supplies one.
   */
  readonly onSuspension?: (fact: MastraDriveSuspensionFact) => Promise<void>;
}

/**
 * The production {@link MastraResumeDriver}: drives the pinned Mastra
 * approve/decline surface against the stored run id, holding the receipt
 * ordering (`started` strictly before the engine can reach the external
 * call). A crash between `started` and `executed` leaves the receipt
 * outcome-unknown — the recovery layer's 待处置, never a replay.
 */
export function createMastraResumeDriver(
  deps: CreateMastraResumeDriverDeps,
): MastraResumeDriver {
  return {
    async resume({
      claim,
      decision,
      receiptSink,
      onSuspension,
      scope,
    }): Promise<MastraResumeDrive> {
      // ME10: the caller's trusted scope rides through for the drive
      // wrapper's runs-service faces; this production driver itself is
      // scope-free (it holds no runs-service authority).
      void scope;
      // ME06: two drive shapes on the SAME durable stack and the SAME
      // receipt ordering — the ME05 approval resume, and the frontend drive
      // (the client's real tool result re-enters the suspended loop). A
      // question continuation still has no wired drive and refuses.
      if (
        claim.payload.kind !== "approval" &&
        claim.payload.kind !== "frontend_tool"
      ) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.driveUnsupported,
          `MASTRA_CONTINUATION_DRIVE_UNSUPPORTED: the production drive mounts the approval and frontend resumes; a ${claim.payload.kind} continuation needs its own drive shape.`,
        );
      }
      if (claim.payload.kind === "approval") {
        if (decision.kind !== "approved" && decision.kind !== "declined") {
          throw new MastraContinuationRefusal(
            MASTRA_CONTINUATION_REFUSALS.decisionIncompatible,
            `MASTRA_CONTINUATION_DECISION_INCOMPATIBLE: an approval continuation is driven by approved/declined decisions, not ${decision.kind}.`,
          );
        }
      } else if (decision.kind !== "tool_result") {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.decisionIncompatible,
          `MASTRA_CONTINUATION_DECISION_INCOMPATIBLE: a frontend_tool continuation is driven by the client's tool_result decision, not ${decision.kind}.`,
        );
      }
      const storage = await deps.storageFor(claim.binding);
      if (!storage) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.storageMissing,
          "MASTRA_CONTINUATION_STORAGE_MISSING: the run's engine storage did not resolve; the suspended snapshot stays isolated, never resumed from a guess.",
        );
      }
      const loop = await deps.loopFor(claim);
      const agentId = loop.agentId ?? `openbot-${claim.binding.botId}`;
      // R3-11 fail-closed gate: durable tools mounted WITHOUT a re-suspension
      // save hook would let the resumed run pause again with no continuation
      // saved — "engine waiting, no recovery data". Refuse the mount instead;
      // the orchestrator always wires the hook, so this refuses only an
      // assembly that cannot recover what it is about to make resumable.
      const durableToolNames = loop.durableToolNames ?? [];
      if (durableToolNames.length > 0 && !onSuspension && !deps.onSuspension) {
        throw new MastraContinuationRefusal(
          MASTRA_CONTINUATION_REFUSALS.resuspensionUnsupported,
          "MASTRA_CONTINUATION_RESUSPENSION_UNSUPPORTED: durable tools are mounted without a re-suspension save hook; a resumed run that pauses again would wait with no recovery data.",
        );
      }
      const saveSuspension = async (
        fact: MastraDriveSuspensionFact,
      ): Promise<void> => {
        const wired = onSuspension ?? deps.onSuspension;
        if (!wired) {
          throw new MastraContinuationRefusal(
            MASTRA_CONTINUATION_REFUSALS.resuspensionUnsupported,
            "MASTRA_CONTINUATION_RESUSPENSION_UNSUPPORTED: the run suspended again but no re-suspension save hook is wired.",
          );
        }
        await wired(fact);
      };
      // Same mount rule as the execution path (buildAgent): the durable
      // approval pause rides the granted tool, so the resumed step suspends
      // the same way the original run did if the engine re-asks.
      const tools: Record<string, unknown> = { ...(loop.tools ?? {}) };
      for (const [name, tool] of Object.entries(tools)) {
        if (durableToolNames.includes(name)) {
          // A CLONE, not the shared instance: a factory that caches its tools would otherwise
          // carry the approval flag into the execution path and every concurrent run. The
          // prototype is preserved so a class-shaped tool keeps its methods.
          const copy = Object.assign(
            Object.create(Object.getPrototypeOf(tool) as object | null),
            tool,
          );
          (copy as { requireApproval?: boolean }).requireApproval = true;
          tools[name] = copy;
        }
      }
      const agent = new Agent({
        id: agentId,
        name: claim.binding.botId,
        instructions: buildInstructions(
          loop.instructions ?? [],
          loop.trailingInstructions ?? [],
        ),
        model: mastraLoopModel(loop.model) as never,
        ...(Object.keys(tools).length > 0 ? { tools: tools as never } : {}),
      });
      // The ME01-proven durable shape: the Mastra instance owns the tenant
      // storage, so the agent's resume reads the persisted suspension. The
      // instance reference is held for the WHOLE drive (R3-12, mirroring the
      // execution path's durable hold): the snapshot registration rides the
      // instance's storage wiring, so it must outlive drainResume — including
      // the re-suspension snapshot a resumed pause writes below.
      const durable = new Mastra({
        agents: { [agentId]: agent },
        storage: storage as never,
      });
      if (decision.kind === "declined") {
        // A declined call never executes: no started/executed receipt may
        // exist for a decline — the receipt ledger records external effects,
        // and a decline has none.
        const output = await agent.declineToolCall({
          runId: claim.binding.executionKey,
          toolCallId: claim.payload.toolCallId,
          reason: decision.reason,
        } as never);
        const produced = await drainResume(output as never, deps.onEvent);
        void durable;
        return { outcome: "declined", ...produced };
      }
      // RECEIPT ORDER (both drive shapes): the operation is recorded
      // outcome-unknown BEFORE the resume can reach the effect — the
      // approval's external call, or the frontend bridge consuming the
      // client's result into the loop — and upgraded only once the stream
      // drained. This is the ordering the recovery rules stand on. F1 fence:
      // `started()` is also the CLAIM fence — it refuses with
      // MASTRA_CONTINUATION_CLAIM_LOST when another driver (a claim
      // takeover) already recorded the receipt, so a driver stalled past its
      // TTL refuses HERE, before resumeStream, and the engine is driven at
      // most once per recorded operation.
      await receiptSink.started();
      const output = await agent.resumeStream(
        (decision.kind === "tool_result"
          ? // The client's real result IS the resume data: the bridge's
            // execute re-runs with it as `resumeData` and returns it as the
            // tool result. The server adds nothing and fabricates nothing.
            (decision.result ?? null)
          : { approved: true }) as never,
        {
          runId: claim.binding.executionKey,
          toolCallId: claim.payload.toolCallId,
          maxSteps: loop.maxSteps ?? TOOL_LOOP_MAX_STEPS,
          // ME10: the run's OWN ceiling rides every resumed dial (the
          // governed adapter refuses an un-ceilinged call), and the retry
          // loop stays off — a 402 budget refusal is terminal by contract.
          modelSettings: {
            ...(loop.maxOutputTokens !== undefined
              ? { maxOutputTokens: loop.maxOutputTokens }
              : {}),
            maxRetries: 0,
          },
        } as never,
      );
      const produced = await drainResume(output as never, deps.onEvent);
      if (produced.finishReason === "suspended") {
        // R3-11: the resumed run paused AGAIN on a durable call. The engine
        // has already persisted the replacement snapshot (the durable stack
        // above owns that storage — the hook's premise), so the only missing
        // recovery data is the OpenBot continuation, saved through the wired
        // hook. The receipt is NEVER upgraded (a drive that ended suspended
        // has not proven the external effect's completion) and the outcome is
        // NOT "resumed": the orchestrator releases this row back to waiting
        // and publishes the distinct re_suspended result.
        const fact = await reSuspensionFact(
          agent,
          claim.binding.executionKey,
          claim.payload.kind,
        );
        try {
          await saveSuspension(fact);
        } catch (error) {
          // The engine has already parked on its own snapshot, so a failed save here is the
          // "engine waiting, no recovery data" state this file's header refuses to allow. The
          // context makes it identifiable to the orchestrator/recovery sweep instead of an
          // anonymous database error that reads as a driver defect.
          throw new Error(
            `MASTRA_RESUSPENSION_SAVE_FAILED executionKey=${claim.binding.executionKey}`,
            { cause: error },
          );
        }
        void durable;
        return { outcome: "re_suspended", ...produced };
      }
      await receiptSink.executed();
      void durable;
      return { outcome: "resumed", ...produced };
    },
  };
}

/**
 * The re-suspension fact, read from the engine's OWN persisted suspension
 * (the snapshot the durable stack just wrote) — never parsed back out of the
 * drained stream. Exactly one pending call of the drive's kind is expected;
 * zero or several refuse instead of guessing the recovery identity (the same
 * refuse-to-guess rule the execution path's save applies). The approval kind
 * reads the approval-paused call's persisted arguments; the frontend kind
 * reads the bridge's own suspend payload ({kind, toolCallId, toolName,
 * args} — the payload frontend-tools.ts suspends with).
 */
async function reSuspensionFact(
  agent: Agent,
  executionKey: string,
  kind: "approval" | "frontend_tool",
): Promise<MastraDriveSuspensionFact> {
  const { runs } = await agent.listSuspendedRuns();
  const suspended = runs.find((run) => run.runId === executionKey);
  const pendings = (suspended?.toolCalls ?? []).filter(
    (call) =>
      call.requiresApproval === (kind === "approval") &&
      typeof call.toolCallId === "string" &&
      call.toolCallId.length > 0 &&
      typeof call.toolName === "string" &&
      call.toolName.length > 0 &&
      // A frontend pause carries the bridge's suspend payload; an approval
      // pause carries the persisted arguments. The other kind's marker must
      // not satisfy this read.
      (kind === "approval" || call.suspendPayload != null),
  );
  const pending = pendings[0];
  if (pendings.length !== 1 || !pending) {
    throw new MastraContinuationRefusal(
      MASTRA_CONTINUATION_REFUSALS.resuspensionUnsupported,
      `MASTRA_CONTINUATION_RESUSPENSION_UNSUPPORTED: the resumed run suspended again but ${
        pendings.length === 0
          ? `no pending ${kind} call`
          : "several pending calls"
      } were discoverable; refusing to guess the recovery identity.`,
    );
  }
  return {
    kind,
    toolCallId: pending.toolCallId as string,
    toolName: pending.toolName as string,
    // The parsed arguments the engine persisted — the same canonicalization
    // base the decision side digests, so the new continuation's decision can
    // actually match.
    argsDigest: argsDigestFor(
      kind === "approval"
        ? (pending.args ?? {})
        : ((pending.suspendPayload as { args?: unknown } | null)?.args ?? {}),
    ),
  };
}

/**
 * Drain one resumed output completely (the run only finishes when its stream
 * is consumed) and collect the produced user-visible facts.
 */
async function drainResume(
  output: {
    fullStream: ReadableStream<unknown>;
    text: Promise<string>;
    finishReason: Promise<string>;
  },
  onEvent: ((event: unknown) => void) | undefined,
): Promise<{ answer: string; finishReason: string }> {
  const reader = output.fullStream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      onEvent?.(next.value);
    }
  } finally {
    // The stream is fully drained by the loop above; cancel is a no-op there
    // and a stop wire if a drain error escaped mid-stream.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return {
    answer: await output.text,
    finishReason: await output.finishReason,
  };
}
