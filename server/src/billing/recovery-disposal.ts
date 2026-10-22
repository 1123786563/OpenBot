import { and, eq, ne } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  creditRecoveryItems,
  creditRecoveryQueries,
  creditReservations,
} from "../db/schema/credit-reservations";
import type { ConversionRate } from "../gateway/conversion-rate";
import { PRICE_DIMENSIONS } from "../gateway/price-snapshot";
import { createCreditSettleService } from "./credit-settle";
import {
  CreditReservationConflictError,
  createCreditWriter,
} from "./credits-writer";

/**
 * The evidenced disposal (Bifrost 08.9, #284): the administrator's settle-or-release
 * command for a recovery item — the money decision the 08.8 review exists to inform, made
 * ONLY through this separately-authorized seam, never through the read surface. 08.10
 * (#285) adds the third action, `compensate`: the platform-loss absorption, an
 * INDEPENDENT audited act that stands on `still_unknown` evidence and is recorded under
 * its own event type — never as a release, never read back as "confirmed no charge".
 *
 * THE COMMAND. { recoveryItemId, action: settle|release|compensate, evidence: { queryId },
 * expectedVersion, operatorId, idempotencyKey, reason? }. Every field is mandatory and
 * operatorId is derived from the AUTHENTICATED session on the route, never read from the
 * body: a command that names its own operator would let anyone forge the trail. `reason`
 * is mandatory for compensate alone — the recorded justification for absorbing the loss.
 *
 * NO EVIDENCE, NO DISPOSAL. A settle stands on a specific `credit_recovery_queries` row
 * whose conclusion is `settled_evidence` WITH its usage — the amount is DERIVED from that
 * row, never chosen by the operator, so "金额与证据一致" is true by construction rather than
 * by hope. A release stands on a `no_charge_evidence` row — the provider's own
 * confirmation the request was never billed — and NOTHING else: `still_unknown` is not
 * release evidence (Q12: 查不到不等于没发生), and a settle-evidence row is the opposite of a
 * no-charge proof. A compensate stands on a `still_unknown` row and NOTHING else: settled
 * evidence belongs to a settle, and no-charge evidence belongs to a release — absorbing a
 * loss the trail can already resolve would be paying for nothing.
 *
 * THE ACCOUNTING GOES THROUGH THE PROTOCOL, NOT AROUND IT. Settle is 06.9's
 * `CreditSettleService` (exact pricing through the reservation's locked basis, the
 * ledger's `reservation:<id>` fence, the first terminal result standing); release is 06.11's
 * recovery door `releaseUnknownReservation` (a still-`reserved` hold refuses, a terminal
 * hold answers the first result). Compensate is 08.10's own door
 * `compensateUnknownReservation` — the held capacity returns to the user, the row's
 * release reason carries the `platform_compensation:` marker, and the audit row records
 * the absorbed amount; the ledger itself gains NO charge row, which is exactly the point:
 * the user did not consume, the platform paid. The disposal never writes a ledger row
 * itself.
 *
 * VERSION AND REPLAY. The item's `version` (0169) is the guard: the resolution lands in
 * ONE UPDATE fenced on `state <> 'resolved' AND version = expectedVersion`, so a command
 * built from a stale read refuses with `version_conflict` and two disposals racing resolve
 * to exactly one winner. A resolved item answers by its record: the SAME idempotency key
 * reads the recorded outcome back (`replayed` — the transport retry, no second effect, no
 * second audit row); a DIFFERENT key refuses with `already_disposed`. Either way there is
 * no second accounting effect — the underlying protocol is terminal-once, and the item
 * names the one disposal that won.
 *
 * THE AUDIT RIDES THE ACT. Every settle-or-release that lands writes
 * `billing.recovery.disposed`; a compensation writes `billing.recovery.compensated` — a
 * different event TYPE, not a different payload of the same one, so the two acts cannot
 * be confused after the fact (08.10's first AC). Both go through the audit store when the
 * deployment wired one — the repo's rule: absent store skips the trail, it never blocks
 * the act. The refusal a non-administrator meets is the ROUTE's own
 * `billing.recovery.disposal_denied` row, mirroring the review surface.
 */

/** The closed refusal vocabulary. A new member is a contract change, never a free string. */
export const DISPOSAL_REFUSAL_REASONS = [
  "request_invalid",
  "no_such_item",
  "version_conflict",
  "already_disposed",
  "evidence_mismatch",
  "settle_refused",
  "release_refused",
  "compensate_refused",
] as const;

export type RecoveryDisposalRefusalReasonCode =
  (typeof DISPOSAL_REFUSAL_REASONS)[number];

/** One line, shown on every surface, per refusal code — the settle surface's discipline. */
export const DISPOSAL_REFUSAL_SENTENCES: Record<
  RecoveryDisposalRefusalReasonCode,
  string
> = {
  request_invalid: "The disposal command is not a valid disposal command.",
  no_such_item: "There is no such recovery item to dispose.",
  version_conflict:
    "The item moved since it was read; re-read the review and dispose against the current version.",
  already_disposed:
    "The item has already been disposed; the first disposal stands.",
  evidence_mismatch:
    "The named evidence does not support this disposal action for this item.",
  settle_refused: "The settlement itself refused; nothing was disposed.",
  release_refused: "The release itself refused; nothing was disposed.",
  compensate_refused:
    "The compensation itself refused; nothing was absorbed and nothing was released.",
};

/** The command contract, as the ticket's Produces list names it. */
export type RecoveryDisposalCommand = {
  recoveryItemId: string;
  action: "settle" | "release" | "compensate";
  /** The specific evidence row the action stands on (08.5's credit_recovery_queries). */
  evidence: { queryId: string };
  /** The version the operator read with the item; a stale version refuses. */
  expectedVersion: number;
  /** The administrator commanding the disposal — the session's own actor on the route. */
  operatorId: string;
  /** The command's own retry identity: the same key replays the recorded answer. */
  idempotencyKey: string;
  /** Compensate only: the recorded justification for absorbing the loss (08.10). */
  reason?: string;
};

/** What a disposal answers: the landed act, the recorded replay, or a named refusal. */
export type RecoveryDisposalOutcome =
  | {
      status: "disposed";
      action: "settle" | "release" | "compensate";
      itemId: string;
      reservationId: string;
      /** The evidence row the act stood on. */
      evidenceId: string;
      /** The item's version after the resolution (the guard for the NEXT disposal). */
      version: number;
      /** Settle only: the protocol's own first-result figures. */
      chargedCredits?: number;
      /** Settle only: what the grants absorbed. */
      appliedCredits?: number;
      /** Release only: the capacity handed back. */
      releasedCredits?: number;
      /** Compensate only: the loss the platform absorbed (the hold's whole ceiling). */
      absorbedCredits?: number;
      /** Compensate only: the recorded justification for absorbing the loss. */
      reason?: string;
    }
  | {
      status: "replayed";
      action: "settle" | "release" | "compensate";
      itemId: string;
      evidenceId: string;
      /** The recorded disposal's own key — the caller sees it answered itself. */
      idempotencyKey: string;
      resolvedAt: string;
    }
  | {
      status: "refused";
      reasonCode: RecoveryDisposalRefusalReasonCode;
      /** The refused command's own facts — never another subject's data. */
      detail: Record<string, unknown>;
    };

export type RecoveryDisposalDependencies = {
  database: Database;
  /** The deployment's environment rate, as the settle service takes it (version-0 locks). */
  environmentRate?: ConversionRate;
  /** Present on a deployment with the audit store; absent skips the trail, as everywhere else. */
  audit?: AuditStore;
  /** The suite's clock; production takes the database's own now. */
  now?: () => Date;
};

const IDENTITY_MAX = 256;

/** Identifier-shaped string: non-empty, bounded, no leading or trailing whitespace. */
function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

function refused(
  reasonCode: RecoveryDisposalRefusalReasonCode,
  detail: Record<string, unknown>,
): Extract<RecoveryDisposalOutcome, { status: "refused" }> {
  return { status: "refused", reasonCode, detail };
}

export function createRecoveryDisposal(
  dependencies: RecoveryDisposalDependencies,
) {
  const { database } = dependencies;
  const writer = createCreditWriter(database);
  const settleService = createCreditSettleService({
    database,
    ...(dependencies.environmentRate !== undefined
      ? { environmentRate: dependencies.environmentRate }
      : {}),
  });
  const now = () => dependencies.now?.() ?? new Date();

  async function dispose(command: unknown): Promise<RecoveryDisposalOutcome> {
    // ---- The shape boundary: every field present and identifier-shaped, the action in
    // the closed vocabulary, the version a whole positive number. A refusal here names
    // the field and nothing else — never a parsed fragment.
    if (typeof command !== "object" || command === null) {
      return refused("request_invalid", { field: "body" });
    }
    const body = command as Record<string, unknown>;
    const action = body.action;
    if (
      action !== "settle" &&
      action !== "release" &&
      action !== "compensate"
    ) {
      return refused("request_invalid", { field: "action" });
    }
    if (!isIdentifier(body.recoveryItemId, IDENTITY_MAX)) {
      return refused("request_invalid", { field: "recoveryItemId" });
    }
    if (!isIdentifier(body.operatorId, IDENTITY_MAX)) {
      return refused("request_invalid", { field: "operatorId" });
    }
    if (!isIdentifier(body.idempotencyKey, IDENTITY_MAX)) {
      return refused("request_invalid", { field: "idempotencyKey" });
    }
    const evidence = body.evidence;
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      !isIdentifier((evidence as Record<string, unknown>).queryId, IDENTITY_MAX)
    ) {
      return refused("request_invalid", { field: "evidence.queryId" });
    }
    const expectedVersion = body.expectedVersion;
    if (
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    ) {
      return refused("request_invalid", { field: "expectedVersion" });
    }
    // 08.10: the compensation's reason is part of the act it records — an absorbed loss
    // without a recorded justification is a fact this seam refuses to hold. Identifier-
    // shaped and bounded, exactly like every other free-ish string the seam accepts.
    let reason: string | undefined;
    if (action === "compensate") {
      if (!isIdentifier(body.reason, 512)) {
        return refused("request_invalid", { field: "reason" });
      }
      reason = body.reason;
    }
    const typed: RecoveryDisposalCommand = {
      recoveryItemId: body.recoveryItemId,
      action,
      evidence: { queryId: (evidence as { queryId: string }).queryId },
      expectedVersion,
      operatorId: body.operatorId,
      idempotencyKey: body.idempotencyKey,
      ...(reason !== undefined ? { reason } : {}),
    };

    // ---- The item, and the resolved-state answers that never re-account.
    const [item] = await database
      .select()
      .from(creditRecoveryItems)
      .where(eq(creditRecoveryItems.id, typed.recoveryItemId))
      .limit(1);
    if (!item) {
      return refused("no_such_item", { recoveryItemId: typed.recoveryItemId });
    }
    if (item.state === "resolved") {
      // The SAME command replayed (transport retry) reads its own recorded answer; a
      // DIFFERENT disposal of a resolved item is the conflict the ticket refuses.
      if (
        item.resolutionIdempotencyKey !== null &&
        item.resolutionIdempotencyKey === typed.idempotencyKey
      ) {
        return {
          status: "replayed",
          action: item.resolvedAction ?? typed.action,
          itemId: item.id,
          evidenceId: item.resolutionEvidenceId ?? typed.evidence.queryId,
          idempotencyKey: item.resolutionIdempotencyKey,
          resolvedAt: item.resolvedAt?.toISOString() ?? now().toISOString(),
        };
      }
      return refused("already_disposed", {
        recoveryItemId: item.id,
        resolvedAction: item.resolvedAction,
        resolvedAt: item.resolvedAt?.toISOString() ?? null,
      });
    }
    if (item.version !== typed.expectedVersion) {
      return refused("version_conflict", {
        recoveryItemId: item.id,
        expectedVersion: typed.expectedVersion,
        currentVersion: item.version,
      });
    }

    // ---- The evidence: a specific row of THIS item's trail, saying what the action
    // needs. This is where "无费用证据不得释放" and "结算必须引用具体证据" live.
    const [evidenceRow] = await database
      .select()
      .from(creditRecoveryQueries)
      .where(eq(creditRecoveryQueries.id, typed.evidence.queryId))
      .limit(1);
    if (!evidenceRow || evidenceRow.itemId !== item.id) {
      return refused("evidence_mismatch", {
        queryId: typed.evidence.queryId,
        reason: "no such evidence row for this item",
      });
    }
    if (typed.action === "settle") {
      if (evidenceRow.conclusion !== "settled_evidence") {
        return refused("evidence_mismatch", {
          queryId: evidenceRow.id,
          conclusion: evidenceRow.conclusion,
          reason: "a settle stands on settled_evidence only",
        });
      }
      if (evidenceRow.usageInput === null || evidenceRow.usageOutput === null) {
        return refused("evidence_mismatch", {
          queryId: evidenceRow.id,
          reason: "the settled evidence carries no usage to settle from",
        });
      }
    } else if (typed.action === "release") {
      if (evidenceRow.conclusion !== "no_charge_evidence") {
        // still_unknown is not release evidence — the provider has no record is NOT proof
        // nothing was billed (Q12), and settled_evidence is the opposite of a no-charge.
        return refused("evidence_mismatch", {
          queryId: evidenceRow.id,
          conclusion: evidenceRow.conclusion,
          reason: "a release stands on no_charge_evidence only",
        });
      }
    } else if (evidenceRow.conclusion !== "still_unknown") {
      // 08.10: the compensation is the act for the loss the trail CANNOT resolve — settled
      // evidence belongs to a settle, no-charge evidence to a release, and absorbing a
      // resolvable loss would be paying for nothing.
      return refused("evidence_mismatch", {
        queryId: evidenceRow.id,
        conclusion: evidenceRow.conclusion,
        reason:
          "a compensate stands on still_unknown only: settle the settled, release the no-charge",
      });
    }

    // ---- The accounting, through the protocol. Refusals here leave everything as it
    // was (the settle service's own discipline); the item is not resolved by a refusal.
    if (typed.action === "settle") {
      // The usage IS the evidence row's: the closed dimension vocabulary with every
      // dimension the row does not carry at zero — the amount cannot disagree with the
      // evidence because the operator never sent an amount at all. Built over the
      // vocabulary itself so a new dimension joins by existing, never by this list.
      const actualUsage = Object.fromEntries(
        PRICE_DIMENSIONS.map((dimension) => [
          dimension,
          dimension === "input"
            ? (evidenceRow.usageInput ?? 0)
            : dimension === "output"
              ? (evidenceRow.usageOutput ?? 0)
              : 0,
        ]),
      ) as Record<(typeof PRICE_DIMENSIONS)[number], number>;
      const settleOutcome = await settleService.settle({
        reservationId: item.reservationId,
        actualUsage,
        evidence: {
          kind: "provider_usage_report",
          reference: evidenceRow.id,
        },
        settledBy: typed.operatorId,
        idempotencyKey: typed.idempotencyKey,
      });
      if (settleOutcome.status === "refused") {
        return refused("settle_refused", {
          reasonCode: settleOutcome.reasonCode,
          detail: settleOutcome.detail,
        });
      }
      const resolution = await resolveItem(
        typed,
        evidenceRow.id,
        item.version,
        item.reservationId,
        { absorbedCredits: 0 },
      );
      if (resolution.status === "refused") return resolution;
      return {
        status: "disposed",
        action: "settle",
        itemId: item.id,
        reservationId: item.reservationId,
        evidenceId: evidenceRow.id,
        version: resolution.version,
        chargedCredits: settleOutcome.chargedCredits,
        appliedCredits: settleOutcome.appliedCredits,
        releasedCredits: settleOutcome.releasedCredits,
      };
    }

    // The release: the recovery door only (a still-`reserved` hold refuses below), with
    // the reason naming the evidence the act stands on.
    if (typed.action === "release") {
      try {
        await writer.releaseUnknownReservation(
          item.reservationId,
          `recovery_disposal:${evidenceRow.id}`,
        );
      } catch (error) {
        if (error instanceof CreditReservationConflictError) {
          return refused("release_refused", {
            kind: error.conflictKind,
            reason: "the reservation's own state refused the recovery release",
          });
        }
        throw error;
      }
      // The row that answered: terminal facts for the response (and an honest released
      // amount even when the release converged on an earlier terminal write).
      const [reservationAfter] = await database
        .select({
          status: creditReservations.status,
          released: creditReservations.released,
        })
        .from(creditReservations)
        .where(eq(creditReservations.id, item.reservationId))
        .limit(1);
      if (reservationAfter?.status !== "released") {
        // The recovery door's own refusal shape: a hold that was never `unknown` (or a
        // settle that landed first). Nothing moved on our say-so; say so.
        return refused("release_refused", {
          reservationStatus: reservationAfter?.status ?? "missing",
          reason: "the reservation did not release",
        });
      }
      const resolution = await resolveItem(
        typed,
        evidenceRow.id,
        item.version,
        item.reservationId,
        { absorbedCredits: 0 },
      );
      if (resolution.status === "refused") return resolution;
      return {
        status: "disposed",
        action: "release",
        itemId: item.id,
        reservationId: item.reservationId,
        evidenceId: evidenceRow.id,
        version: resolution.version,
        releasedCredits: reservationAfter.released ?? 0,
      };
    }

    // The compensation (08.10): the platform's OWN door — not the release, not the settle
    // — with the marker and the justification recorded on the act. The held capacity comes
    // back to the user; the ledger gains no charge row; the absorbed amount is what the
    // audit row carries.
    try {
      await writer.compensateUnknownReservation(
        item.reservationId,
        `platform_compensation:${evidenceRow.id}`,
      );
    } catch (error) {
      if (error instanceof CreditReservationConflictError) {
        return refused("compensate_refused", {
          kind: error.conflictKind,
          reason:
            "the reservation's own state refused the platform compensation",
        });
      }
      throw error;
    }
    const [compensatedAfter] = await database
      .select({
        status: creditReservations.status,
        released: creditReservations.released,
        releaseReason: creditReservations.releaseReason,
      })
      .from(creditReservations)
      .where(eq(creditReservations.id, item.reservationId))
      .limit(1);
    if (
      compensatedAfter?.status !== "released" ||
      !compensatedAfter.releaseReason?.startsWith("platform_compensation:")
    ) {
      // A hold that converged on some OTHER terminal act (a settle or an ordinary release
      // landing first): nothing was absorbed on our say-so; say so.
      return refused("compensate_refused", {
        reservationStatus: compensatedAfter?.status ?? "missing",
        releaseReason: compensatedAfter?.releaseReason ?? null,
        reason: "the reservation was not compensated",
      });
    }
    const compensationResolution = await resolveItem(
      typed,
      evidenceRow.id,
      item.version,
      item.reservationId,
      { absorbedCredits: compensatedAfter.released ?? 0 },
    );
    if (compensationResolution.status === "refused")
      return compensationResolution;
    return {
      status: "disposed",
      action: "compensate",
      itemId: item.id,
      reservationId: item.reservationId,
      evidenceId: evidenceRow.id,
      version: compensationResolution.version,
      absorbedCredits: compensatedAfter.released ?? 0,
      reason: typed.reason,
    };
  }

  /**
   * The one guarded write that resolves the item: `state <> 'resolved' AND version =
   * expectedVersion`. A racing disposal that won in between turns the rowcount to 0 and
   * this command into the resolved-state answers (replay of itself, or the conflict) —
   * the protocol's terminal-once semantics mean the accounting already converged.
   */
  async function resolveItem(
    command: RecoveryDisposalCommand,
    evidenceId: string,
    expectedVersion: number,
    reservationId: string,
    figures: { absorbedCredits: number },
  ): Promise<
    | { status: "resolved"; version: number }
    | Extract<RecoveryDisposalOutcome, { status: "refused" }>
  > {
    const resolvedAt = now();
    const won = await database
      .update(creditRecoveryItems)
      .set({
        state: "resolved",
        version: expectedVersion + 1,
        resolvedAction: command.action,
        resolvedBy: command.operatorId,
        resolvedAt,
        resolutionEvidenceId: evidenceId,
        resolutionIdempotencyKey: command.idempotencyKey,
        updatedAt: resolvedAt,
      })
      .where(
        and(
          eq(creditRecoveryItems.id, command.recoveryItemId),
          eq(creditRecoveryItems.version, expectedVersion),
          // F3/R4-F3（评审两轮）：护栏与声明一致——已 resolved 的行不再被处置
          // 覆写。ne(state) 才有效：08.2 handler 解决只写 state，不写
          // resolved_action 也不递增 version，isNull(resolvedAction) 挡不住它。
          ne(creditRecoveryItems.state, "resolved"),
        ),
      )
      .returning({ version: creditRecoveryItems.version });
    if (won.length === 0) {
      const [current] = await database
        .select()
        .from(creditRecoveryItems)
        .where(eq(creditRecoveryItems.id, command.recoveryItemId))
        .limit(1);
      if (
        current?.resolutionIdempotencyKey !== null &&
        current?.resolutionIdempotencyKey === command.idempotencyKey
      ) {
        // Unreachable in practice (the same key recorded itself above), kept so the
        // race's every exit answers honestly rather than crashing.
        return {
          status: "refused",
          reasonCode: "already_disposed",
          detail: { recoveryItemId: command.recoveryItemId, replayed: true },
        };
      }
      return refused("version_conflict", {
        recoveryItemId: command.recoveryItemId,
        expectedVersion,
        currentVersion: current?.version ?? null,
        reason: "a concurrent disposal resolved the item first",
      });
    }

    // The act's own trail: who disposed, what action, on which evidence, at which
    // version — the audit the ticket demands rides the disposal itself. 08.10: the
    // compensation's trail is its OWN event type, carrying the absorbed amount and the
    // recorded justification, so it can never be read back as "confirmed no charge".
    if (dependencies.audit) {
      await recordAuditEvent(dependencies.audit, {
        eventType:
          command.action === "compensate"
            ? "billing.recovery.compensated"
            : "billing.recovery.disposed",
        targetType: "billing",
        targetId: command.recoveryItemId,
        actorUserId: command.operatorId,
        payload:
          command.action === "compensate"
            ? {
                action: command.action,
                reason: command.reason ?? null,
                absorbedCredits: figures.absorbedCredits,
                evidenceId,
                reservationId,
                expectedVersion,
                idempotencyKey: command.idempotencyKey,
              }
            : {
                action: command.action,
                evidenceId,
                reservationId,
                expectedVersion,
                idempotencyKey: command.idempotencyKey,
              },
      });
    }
    return {
      status: "resolved",
      version: won[0]?.version ?? expectedVersion + 1,
    };
  }

  return { dispose };
}
