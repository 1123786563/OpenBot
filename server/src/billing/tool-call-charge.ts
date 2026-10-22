import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { accessGrants } from "../db/schema";
import { toolCallCharges } from "../db/schema/credit-reservations";
import type { PriceDimension } from "../gateway/price-snapshot";
import { attemptIdForReservation } from "./reservation-status";
import type { ToolSurchargeEntryIdForIdentity } from "./tool-surcharge-pricing";

/*
 * The tool call's own billing identity (Bifrost 20.1, #341): the writer that mints one
 * `tool_call_charges` row per real tool call — the identity half of "每次真实工具调用有
 * 独立计费身份与归属". The admission half (which doors must call this writer, and what
 * refuses before it) is 20.4's (#344) subject; this module is deliberately the plain
 * record: given a call's facts and its admission outcome, persist exactly one identity
 * row, attribution frozen at creation exactly the way async_jobs freezes its own.
 *
 * THE PAYER IS RESOLVED HERE, NOT TRUSTED. Like every door on the personal-key surface,
 * the row's attribution is read server-side off the grant (the grant's own user), never
 * taken from the caller's spelling of it — a caller that names another account cannot
 * attribute its tool calls there, because this writer never reads a payer from the input
 * at all.
 *
 * THE ATTEMPT IS THE RESERVATION'S, BY CONSTRUCTION. A charged row that holds a
 * reservation carries the 07.x attempt id that reservation mints (`att-`, the mapping
 * attemptIdForReservation owns) — computed here from the reservation id, never accepted
 * from the caller, so the bijection a Status query relies on cannot drift. A free call
 * (the basis priced it exactly zero) charges without a hold, so it has no attempt — free
 * is a price, and a hold of zero is not a hold. A refused call never holds a reservation:
 * the refusal reason and the audit trail carry the attempt, not a hold (拒绝不产生任何
 * 账务写入).
 *
 * ONE ROW PER IDEMPOTENT KEY. A replayed tool call (the caller's own durable request
 * identity) converges on the row that already exists and writes nothing — the same
 * convergence the async submit's unique key owns — and the unique reservation index
 * answers a different key trying to claim the same hold with a conflict the database
 * refuses, because one hold mints exactly one tool-call identity.
 */

/** The local charge id's prefix — recognisable on sight, like the reservation's `cr-`. */
export const TOOL_CHARGE_ID_PREFIX = "tc-";

/** What one identity row says, read back verbatim — the answer both writes and replays carry. */
export type ToolCallChargeView = {
  readonly chargeId: string;
  readonly idempotencyKey: string;
  readonly entry: ToolSurchargeEntryIdForIdentity;
  readonly tool: string;
  readonly dimension: PriceDimension;
  readonly grantId: string;
  readonly payer: { readonly kind: string; readonly id: string };
  readonly state: "charged" | "refused";
  readonly reservationId: string | null;
  /** The 07.x attempt id this call's hold minted; null exactly when no hold formed. */
  readonly attemptId: string | null;
  readonly pricedFree: boolean;
  readonly refusalReason: string | null;
  readonly createdAt: Date;
};

/** The admission outcome a charged row records: a hold, or a basis priced exactly free. */
export type ToolCallChargeOutcome =
  | { kind: "charged"; reservationId: string }
  | { kind: "charged-free" }
  | { kind: "refused"; reason: string };

/** What the writer answers: the row (created or already existing), or a closed refusal. */
export type ToolCallChargeRecordOutcome =
  | {
      /** This call created the row. */
      status: "recorded";
      charge: ToolCallChargeView;
    }
  | {
      /** A replay answered the existing row. */
      status: "already";
      charge: ToolCallChargeView;
    }
  | { status: "refused"; reasonCode: "grant_invalid" | "outcome_invalid" };

function viewOf(row: typeof toolCallCharges.$inferSelect): ToolCallChargeView {
  return {
    chargeId: row.chargeId,
    idempotencyKey: row.idempotencyKey,
    entry: row.entry as ToolSurchargeEntryIdForIdentity,
    tool: row.tool,
    dimension: row.dimension as PriceDimension,
    grantId: row.grantId,
    payer: { kind: row.payerKind, id: row.payerId },
    state: row.state,
    reservationId: row.reservationId,
    attemptId:
      row.reservationId === null
        ? null
        : attemptIdForReservation(row.reservationId),
    pricedFree: row.pricedFree,
    refusalReason: row.refusalReason,
    createdAt: row.createdAt,
  };
}

/**
 * Record one real tool call's identity. Pure shape discipline on the input (closed entry
 * and dimension vocabularies, non-empty identities), the payer resolved off the grant,
 * and the insert converged by the idempotency key. A replay answers the existing row —
 * even one recorded with a DIFFERENT outcome — because the first write is the identity:
 * a replay is the same call, not a second opinion.
 */
export async function recordToolCallCharge(
  database: Database,
  input: {
    /** The caller's durable request identity for this call — stable across retries. */
    idempotencyKey: string;
    entry: ToolSurchargeEntryIdForIdentity;
    /** What executed: the `<client>-<tool>` pattern, the search tool, or the agent name. */
    tool: string;
    dimension: PriceDimension;
    grantId: string;
    outcome: ToolCallChargeOutcome;
  },
): Promise<ToolCallChargeRecordOutcome> {
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.length === 0 ||
    input.idempotencyKey.length > 512 ||
    typeof input.tool !== "string" ||
    input.tool.length === 0 ||
    input.tool.length > 512
  ) {
    return { status: "refused", reasonCode: "outcome_invalid" };
  }
  // The attribution the row freezes is read off the grant, never spelled by the caller.
  const [grant] = await database
    .select({ userId: accessGrants.userId })
    .from(accessGrants)
    .where(eq(accessGrants.grantId, input.grantId))
    .limit(1);
  if (!grant) {
    return { status: "refused", reasonCode: "grant_invalid" };
  }
  const charged = input.outcome.kind === "charged";
  const pricedFree = input.outcome.kind === "charged-free";
  const reservationId =
    input.outcome.kind === "charged" ? input.outcome.reservationId : null;

  const inserted = await database
    .insert(toolCallCharges)
    .values({
      chargeId: `${TOOL_CHARGE_ID_PREFIX}${randomBytes(16).toString("hex")}`,
      idempotencyKey: input.idempotencyKey,
      entry: input.entry,
      tool: input.tool,
      dimension: input.dimension,
      grantId: input.grantId,
      payerKind: "personal",
      payerId: grant.userId,
      state: charged || pricedFree ? "charged" : "refused",
      reservationId,
      pricedFree,
      refusalReason:
        input.outcome.kind === "refused" ? input.outcome.reason : null,
    })
    .onConflictDoNothing({ target: toolCallCharges.idempotencyKey })
    .returning();
  if (inserted.length > 0) {
    return { status: "recorded", charge: viewOf(inserted[0]) };
  }
  const [existing] = await database
    .select()
    .from(toolCallCharges)
    .where(eq(toolCallCharges.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) {
    return { status: "already", charge: viewOf(existing) };
  }
  // Not the idempotency conflict the convergence reads — the reservation-unique index
  // refused a second identity claiming the same hold. That is a defect in the caller
  // (two calls sharing one hold), surfaced as an invalid outcome rather than stored.
  return { status: "refused", reasonCode: "outcome_invalid" };
}

/** A grant's tool-call charges, oldest first — the user view's and the sweep's own read. */
export async function listToolCallChargesByGrant(
  database: Database,
  grantId: string,
): Promise<ToolCallChargeView[]> {
  const rows = await database
    .select()
    .from(toolCallCharges)
    .where(eq(toolCallCharges.grantId, grantId));
  return rows
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.chargeId.localeCompare(b.chargeId),
    )
    .map(viewOf);
}
