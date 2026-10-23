/**
 * ME11 (#483): the delivery half of a Bot-to-Bot hop, on the governed
 * headless turn.
 *
 * WHAT MIGRATED. `agents/handoff-delivery.ts` ran the addressed Bot through
 * the Intelligence platform: an AbstractAgent built per hop, the platform's
 * thread lock, an `IntelligenceAgentRunner` socket. This module replaces
 * every one of those authorities with the SAME controlled Mastra execution
 * the web chat and the other unattended entries run (ME09/ME10): the hop's
 * queue row is the durable scheduling record, the runs service admits the
 * turn under an explicit budget with the owner's principal as payer, history
 * is rebuilt from the conversation store, and the answer is persisted back
 * through the single-writer seam. No Intelligence runner, no socket.
 *
 * THE HOP ROW IS THE RECORD. A delivery re-reads `work_items` by the claim's
 * key at the moment of running: a reaped or finished hop, or one whose
 * advance intent already exists, refuses by name before anything is
 * admitted — the reaper can never cause a second run, a second notice or a
 * second conversation. The ONE advance intent is derived from the hop key
 * (`routine-adv:handoff:<key>:<key>`), the SAME stable business identity the
 * desk offered under, so a queue redelivery converges on the first advance.
 *
 * ONE SCRATCH CONVERSATION PER HOP. A forward hop runs the addressed Bot in
 * a scratch conversation nobody is shown (the legacy scratch thread, now a
 * conversation-store row). The thread id is resolved once per hop and
 * written back onto the hop row, so a redelivery reuses the SAME
 * conversation instead of creating a second one. A backwards hop (a relay or
 * a failure notice) runs the asking Bot in the conversation the person is
 * actually watching, exactly as before.
 *
 * THE DEPTH RIDES THE SURFACE. The addressed Bot's only Bot-to-Bot door is
 * the desk-gated `message_bot`, mounted with a run assertion that carries
 * the ORIGINAL signed depth and the hop's own claim — the same assertion the
 * legacy delivery minted, so the desk's per-hop grant check, the fan-out cap
 * and the depth cap bind across every hop of a chain. Nothing Mastra-native
 * substitutes for that authorization, and the addressed Bot runs with its
 * OWN grants, credentials and personal memory (the shared governed surface
 * resolves them per Bot), never the asking Bot's.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { RunAssertion } from "../agents/callback-token";
import { HANDOFF_KIND } from "../agents/handoff";
import { ThreadBusyError } from "../agents/handoff-delivery";
import {
  attribute,
  type HandoffDelivery,
  type HandoffWork,
} from "../agents/handoff-runner";
import { handoffDeliveryRunAssertion } from "../agents/handoff-signing";
import { delegatedWork, HANDOFF_TOOL } from "../agents/handoff-tool";
import type { AuditInitiator } from "../audit";
import { handoffInitiator } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import type { Database } from "../db/client";
import { enterpriseRuns } from "../db/schema/enterprise-runs";
import { workItems } from "../db/schema/work";
import type {
  ConversationService,
  PlatformScope,
} from "../enterprise/contracts";
import { RunDomainError } from "../enterprise/runs/store";
import type { GrantedTool } from "../plugins/tools";
import type { TurnRunner } from "../routines/runner";
import {
  GovernedHeadlessRefusal,
  type GovernedSchedulingRecord,
  governedFiringIntentKey,
} from "./headless";

/** The routineId prefix that marks a governed turn as ONE hop's delivery. */
export const HANDOFF_ENTRY_PREFIX = "handoff:";

/** The named refusals a governed hop delivery produces before any dial. */
export const HANDOFF_HOP_REFUSALS = {
  /**
   * The hop cannot advance: its row is gone (reaped) or finished, or its
   * advance intent was already claimed. Never retried into a second run.
   */
  hopNotAdvanceable: "HANDOFF_HOP_NOT_ADVANCEABLE",
} as const;

/**
 * A hop whose addressed Bot is WAITING — an approval or a participation wait
 * parked durably on its run. Thrown so the runner treats the hop as final
 * and tells the asking Bot the truth (the target is waiting, not done):
 * queueing the hop again would only meet the intent the wait already holds.
 */
export class HandoffTargetWaitingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffTargetWaitingError";
  }
}

/** What a resolved hop record carries: the work and the turn's conversation. */
export interface ResolvedHandoffHop {
  readonly work: HandoffWork;
  readonly threadId: string;
}

/**
 * The hop resolver: reads the hop row NOW and answers with the turn's
 * identity, or null when the hop cannot advance (gone, finished, already
 * advanced). The queue payload is a claim about the row, never a substitute
 * for it.
 */
export type HandoffHopResolver = (
  hopKey: string,
) => Promise<ResolvedHandoffHop | null>;

/**
 * The work payload a hop row carries, as `handoff.ts` wrote it — the
 * coordination subset plus the envelope and the scratch-thread mapping the
 * governed delivery adds.
 */
export const handoffDeliveryPayload = delegatedWork.extend({
  constraints: z.string().optional(),
  expecting: z.string().optional(),
  fromName: z.string().optional(),
  toName: z.string().optional(),
  answerIn: z.string().optional(),
  scratchThreadId: z.string().optional(),
});

/**
 * Reads one hop row as its work. Null for a row that is gone or is not a
 * parseable hop — the delivery refuses rather than guesses.
 */
export function handoffWorkReader(database: Database) {
  return async (
    hopKey: string,
  ): Promise<{
    work: HandoffWork;
    claimedBy: string;
    finishedAt: Date | null;
    payload: Record<string, unknown>;
  } | null> => {
    const [row] = await database
      .select({
        payload: workItems.payload,
        claimedBy: workItems.claimedBy,
        finishedAt: workItems.finishedAt,
      })
      .from(workItems)
      .where(and(eq(workItems.kind, HANDOFF_KIND), eq(workItems.key, hopKey)))
      .limit(1);
    if (!row) return null;
    const parsed = handoffDeliveryPayload.safeParse(row.payload);
    if (!parsed.success) return null;
    return {
      work: parsed.data as HandoffWork,
      claimedBy: row.claimedBy ?? "",
      finishedAt: row.finishedAt,
      payload: row.payload,
    };
  };
}

/**
 * The governed delivery's hop resolver, over the deployment's own database.
 *
 * Everything here answers "may this hop advance, and where" BEFORE the turn
 * is admitted: a finished or reaped row refuses; an existing advance intent
 * refuses (a redelivery converges on the first run without minting a second
 * scratch conversation); a forward hop resolves its scratch conversation
 * once and writes the mapping back onto the row. A member revoked between
 * offer and delivery throws from the directory's own answer (`scopeFor`) —
 * the hop never runs under a scanned identity.
 */
export function createGovernedHandoffRecordResolver(deps: {
  database: Database;
  /**
   * The trusted directory, the same resolver every governed headless entry
   * signs its scope from. Asked against the ASKING thread (the hop row's
   * own conversation) — the scratch conversation lives in the same tenant.
   */
  scopeFor: (input: {
    ownerUserId: string;
    threadId: string;
  }) => Promise<PlatformScope>;
  conversations: Pick<ConversationService, "getOrCreate">;
}): HandoffHopResolver {
  const readHop = handoffWorkReader(deps.database);
  return async (hopKey) => {
    const hop = await readHop(hopKey);
    if (!hop || hop.finishedAt) return null;
    const work = hop.work;
    // The ONE advance intent, checked before any conversation is resolved or
    // created: a redelivery converges here instead of minting a second
    // scratch conversation and meeting the runs service's refusal after.
    const intentKey = governedFiringIntentKey(
      `${HANDOFF_ENTRY_PREFIX}${hopKey}`,
      hopKey,
    );
    const [prior] = await deps.database
      .select({ id: enterpriseRuns.id })
      .from(enterpriseRuns)
      .where(eq(enterpriseRuns.clientMessageKey, intentKey))
      .limit(1);
    if (prior) return null;
    // A backwards hop (relay/notice) runs in the conversation the person is
    // watching; it exists already and needs nothing minted.
    if (work.answerIn) return { work, threadId: work.answerIn };
    if (work.scratchThreadId) {
      const scope = await deps.scopeFor({
        ownerUserId: work.actorId,
        threadId: work.threadId,
      });
      try {
        const conversation = await deps.conversations.getOrCreate(scope, {
          threadId: work.scratchThreadId,
        });
        return { work, threadId: conversation.thread_id };
      } catch (cause) {
        // The mapped conversation was dropped under the row: recreate it and
        // remap, rather than refusing a deliverable hop for ever.
        if (
          !(cause instanceof Error) ||
          cause.message !== "CONVERSATION_NOT_FOUND"
        ) {
          throw cause;
        }
      }
    }
    const scope = await deps.scopeFor({
      ownerUserId: work.actorId,
      threadId: work.threadId,
    });
    const conversation = await deps.conversations.getOrCreate(scope, {});
    await deps.database
      .update(workItems)
      .set({
        payload: { ...hop.payload, scratchThreadId: conversation.thread_id },
      })
      .where(and(eq(workItems.kind, HANDOFF_KIND), eq(workItems.key, hopKey)));
    return {
      work: { ...work, scratchThreadId: conversation.thread_id },
      threadId: conversation.thread_id,
    };
  };
}

/**
 * The governed turn's scheduling-record adapter: the hop resolver's answer,
 * shaped for the shared turn. The instruction is the addressed Bot's own —
 * the attributed envelope for a forward hop, the carried text for a
 * backwards one — read from the ROW, never from the delivery call's copy.
 */
export function handoffSchedulingRecordFor(
  resolver: HandoffHopResolver,
): (routineId: string) => Promise<GovernedSchedulingRecord | null> {
  return async (routineId) => {
    const hopKey = routineId.startsWith(HANDOFF_ENTRY_PREFIX)
      ? routineId.slice(HANDOFF_ENTRY_PREFIX.length)
      : routineId;
    const hop = await resolver(hopKey);
    if (!hop) return null;
    return {
      agentId: hop.work.toBotId,
      threadId: hop.threadId,
      instruction: hop.work.answerIn ? hop.work.task : attribute(hop.work),
      enabled: true,
      frame: "none",
    };
  };
}

/**
 * The governed hop delivery: the `HandoffDelivery` the runner consumes when
 * the deployment runs the enterprise assembly. The queue claim is the hop's
 * stable business identity — the runner holds the lease, the turn keys its
 * ONE advance intent on it, and every outcome is translated honestly:
 *
 *   - the reply text rides back for the relay (null for a wordless turn);
 *   - a parked wait is a {@link HandoffTargetWaitingError}, never a success;
 *   - a busy conversation is a {@link ThreadBusyError} (the legacy
 *     wait-not-fail semantics: released for a quick retry, not a failure);
 *   - a deployment-controls refusal keeps its name, so the runner's
 *     final-refusal branch still finishes the hop instead of retrying it;
 *   - a gone/already-advanced hop refuses by name before anything dials.
 */
export function createGovernedHandoffDelivery(options: {
  /** The governed headless turn this entry was selected onto. */
  turn: TurnRunner;
  /** The hop resolver over the deployment's own rows. */
  resolver: HandoffHopResolver;
  /**
   * The asking channel's busy light, for the forward leg that runs in a
   * scratch conversation nobody watches — the same visibility the legacy
   * delivery gave the person. Best-effort, paired.
   */
  setBusy?: (input: { threadId: string; busy: boolean }) => Promise<void>;
}): HandoffDelivery {
  return {
    async deliver({ work, claim }) {
      if (!claim) {
        throw new GovernedHeadlessRefusal(
          HANDOFF_HOP_REFUSALS.hopNotAdvanceable,
          "HANDOFF_HOP_NOT_ADVANCEABLE: the delivery carries no queue claim, so there is no stable identity to advance under.",
        );
      }
      const record = await options.resolver(claim.key);
      if (!record) {
        throw new GovernedHeadlessRefusal(
          HANDOFF_HOP_REFUSALS.hopNotAdvanceable,
          "HANDOFF_HOP_NOT_ADVANCEABLE: the hop's record is gone, finished, or its advance intent was already claimed; a redelivery does not run it twice.",
        );
      }
      const lightsAskingChannel = !work.answerIn;
      if (lightsAskingChannel) {
        await options
          .setBusy?.({ threadId: work.threadId, busy: true })
          .catch(() => {});
      }
      try {
        const result = await options.turn({
          ownerUserId: work.actorId,
          // The hop row IS the record and the identity: the turn re-reads it
          // by this key and derives one advance intent per hop.
          routineId: `${HANDOFF_ENTRY_PREFIX}${claim.key}`,
          runId: claim.key,
          agentId: work.toBotId,
          threadId: record.threadId,
          instruction: work.task,
          initiator: handoffInitiator(work.fromBotId, work.initiator),
          depth: work.depth,
        });
        return { answer: result.replyText || null };
      } catch (cause) {
        if (cause instanceof HeadlessToolSuspension) {
          const waiting: HeadlessToolSuspension["waiting"] = cause.waiting;
          throw new HandoffTargetWaitingError(
            `The Bot it asked is waiting for a decision (${waiting.kind}: ${waiting.toolName}) and has not answered yet.`,
          );
        }
        if (
          cause instanceof RunDomainError &&
          cause.code === "ACTIVE_RUN_CONFLICT"
        ) {
          throw new ThreadBusyError(
            `${record.threadId} is busy with another run; the hop will be tried again`,
          );
        }
        throw cause;
      } finally {
        if (lightsAskingChannel) {
          await options
            .setBusy?.({ threadId: work.threadId, busy: false })
            .catch(() => {});
        }
      }
    },
  };
}

/**
 * The governed hop surface's coordination tools: the addressed Bot's ONE
 * Bot-to-Bot door, mounted from the hop's OWN signed identity.
 *
 * `toolsForDeliveryRun` is the deployment's coordination assembly (index
 * wires it to the same `coordinationForActor` a person's run uses, with the
 * desk, the approval gate and the private-share gate behind it). The run
 * handed to it carries the ORIGINAL depth from the hop row and the hop's
 * queue claim — so a chain's next hop is refused exactly where the legacy
 * desk refused it, at the same cap, against the same live grant. Everything
 * else the model might name is filtered out: no person-question tool on an
 * unattended surface (the ME10 contract), and no Mastra-native sub-agent
 * rule standing in for the desk's authorization.
 */
export function governedHandoffSurfaceTools(deps: {
  /** The hop row, read for THIS turn; null mounts nothing. */
  workFor: (hopKey: string) => Promise<{
    work: HandoffWork;
    claimedBy: string;
  } | null>;
  toolsForDeliveryRun: (input: {
    scope: PlatformScope;
    agentId: string;
    initiator: AuditInitiator;
    work: HandoffWork;
    claim: { key: string; owner: string };
    /** The hop's own run identity, at the carried depth. Unsigned here. */
    run: RunAssertion;
  }) => Promise<GrantedTool[]>;
}): (input: {
  scope: PlatformScope;
  agentId: string;
  initiator: AuditInitiator;
  threadId: string;
  routineId: string;
}) => Promise<GrantedTool[]> {
  return async (input) => {
    if (!input.routineId.startsWith(HANDOFF_ENTRY_PREFIX)) return [];
    const hopKey = input.routineId.slice(HANDOFF_ENTRY_PREFIX.length);
    const found = await deps.workFor(hopKey);
    if (!found) return [];
    const claim = { key: hopKey, owner: found.claimedBy };
    const run = handoffDeliveryRunAssertion(
      found.work,
      crypto.randomUUID(),
      claim,
    );
    const tools = await deps.toolsForDeliveryRun({
      scope: input.scope,
      agentId: input.agentId,
      initiator: input.initiator,
      work: found.work,
      claim,
      run,
    });
    return tools.filter((tool) => tool.name === HANDOFF_TOOL);
  };
}
