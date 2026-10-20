import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { usageOutbox } from "../db/schema";
import {
  creditRecoveryItems,
  creditRecoveryQueries,
} from "../db/schema/credit-reservations";
import {
  createRecoveryScanner,
  type RecoveryItem,
  type RecoveryScanner,
} from "./recovery-scan";

/*
 * The provider final-state query for an unknown-dispatch recovery item (Bifrost 08.5).
 *
 * THE QUESTION THIS MODULE ASKS. A hold whose provider result never reliably arrived keeps
 * occupying credit (Q12: the clock, the client's cancellation and the absence of logs are
 * all NOT release evidence). At some point somebody has to ask the PROVIDER what actually
 * became of the attempt — this module is that ask, and the honest bookkeeping of its
 * answer. It never releases, never settles, never re-dispatches: the disposal that acts on
 * a conclusion is 08.9's, and this module only produces the evidence that disposal stands
 * on. Keeping the two apart is what makes "进入释放路径" a fact with a trail, not a
 * side effect of a query.
 *
 * THE THREE-WAY ANSWER (the ticket's classification, snake_case in storage):
 * - `settled_evidence` — the provider confirms the work completed, with its own usage
 *   summary when it has one. The hold is still untouched; the disposal settles from this
 *   evidence under the attempt's idempotency key.
 * - `no_charge_evidence` — the provider confirms the request was never billed (refused or
 *   undispatched). The ONLY conclusion that may enter the release path; even then this
 *   module does not release — 08.9 reads the evidence and acts.
 * - `still_unknown` — the provider has no record of the request, or the query itself
 *   failed (unreachable, timeout, unmappable answer). "查不到" is not "没发生": the hold
 *   stays occupied, the item's failure count grows, and the next pass (08.4's cadence)
 *   asks again. A source answer this module cannot classify is still-unknown BY
 *   CONSTRUCTION — an optimistic read of an ambiguous answer is exactly the "no record
 *   means free" bug this ticket exists to prevent.
 *
 * WHERE THE ANSWER COMES FROM. A `ProviderFinalStateSource` is injected: the seam the
 * caller wires to whatever can actually answer for a call type — Bifrost jobaccounting's
 * job pollers for provider-side async jobs (batches, video), a provider request-log
 * lookup for text calls, a realtime-unit ledger. No source is registered by default:
 * until one is wired, this module's callers get a hard refusal (see
 * `createProviderQueryRecovery`'s guard), so an unwired capability cannot quietly
 * answer `still_unknown` from nothing — feature admission, the same discipline the
 * protocol's other faces keep.
 *
 * THE ITEM LIFECYCLE. The handler claims through 08.1's scanner (one worker per item) and
 * hands every item back to `pending` — its conclusions are evidence for 08.9's disposal,
 * not the disposal itself, so resolving here would orphan the item from the disposal that
 * still owes the money action. `failureCount` moves ONLY on still-unknown (the ticket's
 * rule): a successful query is not a failure, whatever it concluded. `lastReason` carries
 * the newest conclusion's stable code so 08.4's retry and 08.8's view can read the item
 * without joining the evidence trail — the trail stays for those who need the whole story.
 *
 * NOT THIS HANDLER'S SHAPE: an item whose result was PERSISTED but never acked belongs to
 * 08.2's replay (its settle is idempotent and exact); querying a provider about a result
 * this server already holds would be asking a worse witness. The handler detects that
 * shape first and hands the item back untouched, the same symmetry the replay keeps in
 * the other direction.
 */

/** What a source answers about one attempt. The closed vocabulary maps 1:1 onto the
 * evidence table's `conclusion` column; anything else the source says is a defect in the
 * source and lands as `still_unknown` with the unmappable answer as its summary. */
export type SettledEvidenceAnswer = {
  conclusion: "settled_evidence";
  /** The provider's own usage numbers when it has them; absent is legal — the disposal
   * settles from whatever evidence exists, never invents numbers. */
  usage?: { input: number; output: number };
  /** Bounded raw excerpt of what the source said; evidence, not prose. */
  summary: string;
};

export type NoChargeEvidenceAnswer = {
  conclusion: "no_charge_evidence";
  /** Why the provider says nothing was billed (refused, never dispatched). */
  summary: string;
};

export type StillUnknownAnswer = {
  conclusion: "still_unknown";
  /** No record of the request, or the query failed; the stable reason. */
  summary: string;
};

export type ProviderFinalStateAnswer =
  | SettledEvidenceAnswer
  | NoChargeEvidenceAnswer
  | StillUnknownAnswer;

/** The seam a call-type-specific wiring implements: ask about one attempt, get exactly one
 * answer. Implementations must never throw for a provider-shaped outcome ("no record" is
 * an answer); a transport failure MAY throw — this module catches it and records
 * still-unknown, because an unreachable witness is not evidence of anything. */
export type ProviderFinalStateSource = {
  /** The source's own name, recorded on every evidence row it produces. */
  readonly name: string;
  /** Ask about one attempt identified by the recovery item's facts. */
  queryFinalState(item: RecoveryItem): Promise<ProviderFinalStateAnswer>;
};

/** The stable lastReason codes this module writes (closed vocabulary, snake_case). */
export const QUERY_REASON = {
  settledEvidence: "provider_settled_evidence",
  noChargeEvidence: "provider_no_charge_evidence",
  stillUnknown: "provider_still_unknown",
  /** The replay-lane handback: the persisted-result handler owns this item. */
  replayLane: "replay_lane_persisted_result",
} as const;

/** What one processed item answered, for the batch counters and the caller's logs. */
export type ProviderQueryOutcome =
  | "settled_evidence"
  | "no_charge_evidence"
  | "still_unknown"
  | "replay_lane";

export type ProviderQueryItemResult = {
  outcome: ProviderQueryOutcome;
  /** The evidence row this query appended, when it produced one. */
  evidenceId: string | null;
};

export type ProviderQueryBatch = {
  claimed: number;
  settledEvidence: number;
  noChargeEvidence: number;
  stillUnknown: number;
  replayLane: number;
};

export type ProviderQueryRecovery = {
  /** Process one already-claimed item: query the source, append the evidence row, hand
   * the item back to pending with the conclusion's stable reason. Throws only for caller
   * defects (bad worker id, unclaimed item); a source failure is an outcome, not a throw. */
  processClaimedItem(
    item: RecoveryItem,
    workerId: string,
  ): Promise<ProviderQueryItemResult>;
  /** Claim up to `limit` pending items and process each; the batch entry 08.4's scheduler
   * drives. One item's failure never stops the batch. */
  queryFinalStates(
    workerId: string,
    limit?: number,
  ): Promise<ProviderQueryBatch>;
};

export type ProviderQueryRecoveryDependencies = {
  database: Database;
  /** The seam this module asks; REQUIRED — see the module comment on admission. */
  source: ProviderFinalStateSource;
  /** Injectable scanner; 08.1's over the same database by default. */
  scanner?: RecoveryScanner;
  /** Injectable clock; the app clock by default. */
  now?: () => Date;
  /** Stable-code operational log (no driver error text); console.warn by default. */
  log?: (message: string) => void;
};

/** The evidence row id shape: `crq-` plus 8 random bytes as hex (the item's `cri-` draw). */
function generateQueryEvidenceId(): string {
  return `crq-${randomBytes(8).toString("hex")}`;
}

function isNonEmptyIdentifier(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/** How much of a source's summary the evidence row keeps: enough to be evidence, little
 * enough that a chatty source cannot turn the trail into a log dump. */
const MAX_SUMMARY_LENGTH = 512;

function boundedSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length <= MAX_SUMMARY_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

export function createProviderQueryRecovery(
  dependencies: ProviderQueryRecoveryDependencies,
): ProviderQueryRecovery {
  const { database } = dependencies;
  const source = dependencies.source;
  if (!source || !isNonEmptyIdentifier(source.name, 256)) {
    throw new TypeError(
      "createProviderQueryRecovery: a provider final-state source with a non-empty name of at most 256 characters is required — an unwired capability must refuse, not answer still_unknown from nothing",
    );
  }
  if (typeof source.queryFinalState !== "function") {
    throw new TypeError(
      "createProviderQueryRecovery: the source must implement queryFinalState(item)",
    );
  }
  const scanner = dependencies.scanner ?? createRecoveryScanner({ database });
  const now = () => dependencies.now?.() ?? new Date();
  // biome-ignore lint/suspicious/noConsole: stable-code operational log
  const log = dependencies.log ?? ((message: string) => console.warn(message));

  /** Append this query's evidence row. Append-only by construction: one insert, no
   * update path exists. The row is written BEFORE the item's lastReason moves, so a crash
   * between the two leaves evidence without a pointer — harmless (the trail keeps it) —
   * rather than a pointer without evidence, which would be a lie. */
  async function appendEvidence(input: {
    itemId: string;
    item: RecoveryItem;
    conclusion: ProviderFinalStateAnswer["conclusion"];
    summary: string;
    usage: { input: number; output: number } | null;
  }): Promise<string> {
    const id = generateQueryEvidenceId();
    await database.insert(creditRecoveryQueries).values({
      id,
      itemId: input.itemId,
      reservationId: input.item.reservationId,
      attemptId: input.item.attemptId,
      source: source.name,
      conclusion: input.conclusion,
      summary: boundedSummary(input.summary),
      usageInput: input.usage?.input ?? null,
      usageOutput: input.usage?.output ?? null,
      queriedAt: now(),
    });
    return id;
  }

  /** Hand the claimed item back to `pending`, moving the failure count only when this
   * query failed to establish anything. Guarded on the claim, exactly like 08.2's
   * handback, so a worker that lost its claim writes nothing. */
  async function handBack(
    itemId: string,
    reason: string,
    countFailure: boolean,
  ): Promise<void> {
    await database
      .update(creditRecoveryItems)
      .set({
        state: "pending",
        claimedAt: null,
        claimedBy: null,
        lastReason: reason,
        ...(countFailure
          ? { failureCount: sql`${creditRecoveryItems.failureCount} + 1` }
          : {}),
        updatedAt: now(),
      })
      .where(
        and(
          eq(creditRecoveryItems.id, itemId),
          eq(creditRecoveryItems.state, "claimed"),
        ),
      );
  }

  async function processClaimedItem(
    item: RecoveryItem,
    workerId: string,
  ): Promise<ProviderQueryItemResult> {
    if (!isNonEmptyIdentifier(workerId, 512)) {
      throw new TypeError(
        "processClaimedItem: workerId must be a non-empty identifier of at most 512 characters",
      );
    }
    if (item.state !== "claimed") {
      throw new TypeError(
        "processClaimedItem: the item must be claimed (state 'claimed'); claim it via the recovery scanner first",
      );
    }

    // 08.2's shape: the result was persisted and the replay owns the money action. Asking
    // the provider about a fact this server already holds would trade an exact settle for
    // a worse witness, so the item goes back untouched — the mirror of the replay's own
    // "no persisted result" handback.
    const [persisted] = await database
      .select({ eventId: usageOutbox.eventId })
      .from(usageOutbox)
      .where(eq(usageOutbox.reservationId, item.reservationId))
      .orderBy(asc(usageOutbox.createdAt), asc(usageOutbox.eventId))
      .limit(1);
    if (persisted) {
      await handBack(item.id, QUERY_REASON.replayLane, false);
      return { outcome: "replay_lane", evidenceId: null };
    }

    let answer: ProviderFinalStateAnswer;
    try {
      answer = await source.queryFinalState(item);
    } catch (error) {
      // An unreachable or failing witness is not evidence of anything: still-unknown,
      // failure count, and the trail says the query itself failed. The log carries the
      // stable code only — a driver error can carry connection details.
      log(
        `billing: provider final-state query failed reservation=${item.reservationId} attempt=${item.attemptId}`,
      );
      const summary = `provider_query_failed: ${error instanceof Error ? error.constructor.name : "unknown error"}`;
      const evidenceId = await appendEvidence({
        itemId: item.id,
        item,
        conclusion: "still_unknown",
        summary,
        usage: null,
      });
      await handBack(item.id, QUERY_REASON.stillUnknown, true);
      return { outcome: "still_unknown", evidenceId };
    }

    // An answer this module cannot classify is still-unknown BY CONSTRUCTION — the
    // optimistic read of an ambiguous answer is the bug this ticket exists to prevent.
    const classified = classifyAnswer(answer);

    switch (classified.conclusion) {
      case "settled_evidence": {
        const evidenceId = await appendEvidence({
          itemId: item.id,
          item,
          conclusion: "settled_evidence",
          summary: classified.summary,
          usage: classified.usage ?? null,
        });
        await handBack(item.id, QUERY_REASON.settledEvidence, false);
        return { outcome: "settled_evidence", evidenceId };
      }
      case "no_charge_evidence": {
        const evidenceId = await appendEvidence({
          itemId: item.id,
          item,
          conclusion: "no_charge_evidence",
          summary: classified.summary,
          usage: null,
        });
        await handBack(item.id, QUERY_REASON.noChargeEvidence, false);
        return { outcome: "no_charge_evidence", evidenceId };
      }
      case "still_unknown": {
        const evidenceId = await appendEvidence({
          itemId: item.id,
          item,
          conclusion: "still_unknown",
          summary: classified.summary,
          usage: null,
        });
        await handBack(item.id, QUERY_REASON.stillUnknown, true);
        return { outcome: "still_unknown", evidenceId };
      }
    }
  }

  return {
    processClaimedItem,
    async queryFinalStates(workerId, limit = 10) {
      if (!isNonEmptyIdentifier(workerId, 512)) {
        throw new TypeError(
          "queryFinalStates: workerId must be a non-empty identifier of at most 512 characters",
        );
      }
      if (!Number.isInteger(limit) || limit < 1) {
        throw new TypeError(
          "queryFinalStates: limit must be a positive integer",
        );
      }
      const items = await scanner.claimRecoveryItems(workerId, limit);
      const batch: ProviderQueryBatch = {
        claimed: items.length,
        settledEvidence: 0,
        noChargeEvidence: 0,
        stillUnknown: 0,
        replayLane: 0,
      };
      for (const item of items) {
        const result = await processClaimedItem(item, workerId);
        if (result.outcome === "settled_evidence") batch.settledEvidence += 1;
        else if (result.outcome === "no_charge_evidence")
          batch.noChargeEvidence += 1;
        else if (result.outcome === "still_unknown") batch.stillUnknown += 1;
        else batch.replayLane += 1;
      }
      return batch;
    },
  };
}

/*
 * The classifier, lifted out of the handler so the rule is a testable pure function: a
 * well-formed answer passes through with its summary; a source that answered a shape this
 * vocabulary cannot hold becomes still_unknown carrying the defect as its summary. The
 * usage pair must be two finite non-negative integers — a partial or negative usage report
 * is not evidence, it is a guess.
 */
export function classifyAnswer(
  answer: ProviderFinalStateAnswer,
): SettledEvidenceAnswer | NoChargeEvidenceAnswer | StillUnknownAnswer {
  if (
    answer === null ||
    typeof answer !== "object" ||
    !("conclusion" in answer)
  ) {
    return {
      conclusion: "still_unknown",
      summary: "unmappable_source_answer: not an answer object",
    };
  }
  const conclusion = (answer as { conclusion: unknown }).conclusion;
  if (
    conclusion !== "settled_evidence" &&
    conclusion !== "no_charge_evidence" &&
    conclusion !== "still_unknown"
  ) {
    return {
      conclusion: "still_unknown",
      summary: `unmappable_source_answer: ${String(conclusion)}`,
    };
  }
  const summary = (answer as { summary?: unknown }).summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    return {
      conclusion: "still_unknown",
      summary: "unmappable_source_answer: no summary",
    };
  }
  if (conclusion === "settled_evidence") {
    const usage = (answer as { usage?: unknown }).usage;
    if (usage !== undefined) {
      const isWhole = (v: unknown) =>
        typeof v === "number" && Number.isInteger(v) && v >= 0;
      const map = usage as { input?: unknown; output?: unknown };
      if (!isWhole(map.input) || !isWhole(map.output)) {
        return {
          conclusion: "still_unknown",
          summary: `unmappable_source_answer: usage is not a whole non-negative pair (${JSON.stringify(usage)})`,
        };
      }
    }
  }
  return answer;
}
