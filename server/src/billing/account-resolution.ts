import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { billingAccountResolutions, payerAccounts } from "../db/schema/billing";
import { paymentEvents, paymentOrders } from "../db/schema/payment";

/*
 * The account-level resolution registry (Bifrost BP06, #374): the one door through
 * which an authorized operator's account-scope disposal decision is REGISTERED —
 * 补发 (reissue) / 结算 (settle) / 释放 (release) / 平台承担损失 (absorb) / 人工退款
 * (refund) — with its evidence, its operator, its idempotency, and its audit trail.
 *
 * A REGISTRY, NOT A MONEY MOVER. The actions' effects go through their own doors: a
 * reservation settles or releases only through 08.9's evidenced disposal on its recovery
 * item, a plan redelivers through the activation path, a channel refund is executed on
 * the channel and REGISTERED here. What this module owns is the record's integrity — the
 * ticket's own three guarantees:
 *
 *   可重放不重复 (replayable, never duplicated). The command's idempotency key is the
 *   database's own UNIQUE index: a transport retry of the SAME command reads the recorded
 *   row back (`replayed`, no second row, no second audit event); a DIFFERENT command is a
 *   different row, judged on its own merits — the registry does not pretend two commands
 *   are one because they concern the same account.
 *
 *   未经证据不能 (no evidence, no registration). Every command names its evidence as a
 *   kind from the closed vocabulary plus the specific reference. A command without it
 *   refuses before anything is written — the same discipline 08.9 holds for releasing an
 *   unknown hold, applied to every account-scope action, because "the operator felt like
 *   it" is not a fact a replay can stand on.
 *
 *   未授权或超可退额拒绝 (unauthorized or over-refund refuses). The authorization is a
 *   SEAM the route owns (the session's own admin check, exactly as the recovery disposal
 *   route derives its operator); this module refuses `unauthorized` when the seam says
 *   no, with an audit row of its own. The refund ceiling is arithmetic over facts this
 *   deployment already holds: Σ paid-fact amounts on the account's own orders − Σ the
 *   account's already-registered refunds is the refundable balance, and a refund past it
 *   refuses with the numbers in the refusal. Money on orders no mapping attributes to
 *   the account is not refundable through this seam (Q23: never guess an owner).
 */

/** The closed action vocabulary — the five words the ticket names, no sixth. */
export const ACCOUNT_RESOLUTION_ACTIONS = [
  "reissue",
  "settle",
  "release",
  "absorb",
  "refund",
] as const;

export type AccountResolutionAction =
  (typeof ACCOUNT_RESOLUTION_ACTIONS)[number];

/** What a command may stand on. Closed vocabulary; the reference names the specific row. */
export const ACCOUNT_RESOLUTION_EVIDENCE_KINDS = [
  /** A reconcile finding (this pass's or T7's). */
  "reconcile_finding",
  /** A payment_events row (a fact or an archived anomaly). */
  "payment_event",
  /** A credit_recovery_queries evidence row (08.5's). */
  "recovery_evidence",
  /** The operator's own recorded statement, for actions with no row to cite. */
  "operator_statement",
] as const;

export type AccountResolutionEvidenceKind =
  (typeof ACCOUNT_RESOLUTION_EVIDENCE_KINDS)[number];

/** Why a registration refused. Closed vocabulary, displayable. */
export const ACCOUNT_RESOLUTION_REFUSALS = [
  "request_invalid",
  "unauthorized",
  "refund_ceiling_exceeded",
] as const;

export type AccountResolutionRefusalCode =
  (typeof ACCOUNT_RESOLUTION_REFUSALS)[number];

/** One line per refusal code, shown on every surface. */
export const ACCOUNT_RESOLUTION_REFUSAL_SENTENCES: Record<
  AccountResolutionRefusalCode,
  string
> = {
  request_invalid: "The resolution command is not a valid resolution command.",
  unauthorized:
    "Recording an account resolution requires an authorized operator; the command was refused and the refusal recorded.",
  refund_ceiling_exceeded:
    "The refund exceeds the account's refundable balance (paid facts minus registered refunds); nothing was registered.",
};

/** The command contract. */
export type AccountResolutionCommand = {
  /** The credit account the disposal concerns. */
  accountKey: string;
  action: AccountResolutionAction;
  /** The operator's stable snake_case reason word. */
  reasonCode: string;
  /** What the command stands on — mandatory, kind from the closed set plus the reference. */
  evidence: { kind: AccountResolutionEvidenceKind; reference: string };
  /** The operator commanding the disposal; the route derives it from the session. */
  operatorId: string;
  /** The command's retry identity. */
  idempotencyKey: string;
  /** The money the action concerns; REQUIRED for refund, optional for the others. */
  amountCents?: number;
  /** The operator's bounded words for what was done. */
  detail: string;
};

export type AccountResolutionRow =
  typeof billingAccountResolutions.$inferSelect;

/** What a command answers: registered, replayed, or refused with its code. */
export type AccountResolutionOutcome =
  | { status: "registered"; resolution: AccountResolutionRow }
  | { status: "replayed"; resolution: AccountResolutionRow }
  | {
      status: "refused";
      reasonCode: AccountResolutionRefusalCode;
      detail: Record<string, unknown>;
    };

/** How long the operator's words may run — a registry is not a diary. */
const MAX_DETAIL_LENGTH = 2_000;

const REASON_CODE_SHAPE = /^[a-z0-9_]{1,64}$/;

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

export type AccountResolutionService = {
  /** Register one authorized account-scope disposal decision. */
  recordResolution(command: unknown): Promise<AccountResolutionOutcome>;
  /** The account's registered resolutions, oldest first — the replay and ceiling reads. */
  resolutionsOf(accountKey: string): Promise<AccountResolutionRow[]>;
};

export type AccountResolutionDependencies = {
  database: Database;
  /**
   * The authorization seam: may THIS operator record account resolutions? The route
   * wires the session's admin check here; a missing seam refuses everything — an
   * unauthorized door that works is worse than no door.
   */
  authorize: (operatorId: string) => boolean | Promise<boolean>;
  /** The audit store, when the deployment wired one; absent skips the trail, never the act. */
  audit?: AuditStore;
};

export function createAccountResolutionService(
  dependencies: AccountResolutionDependencies,
): AccountResolutionService {
  const { database } = dependencies;

  async function refuseWithAudit(
    command: AccountResolutionCommand | null,
    reasonCode: AccountResolutionRefusalCode,
    detail: Record<string, unknown>,
  ): Promise<AccountResolutionOutcome> {
    if (dependencies.audit && command) {
      await recordAuditEvent(dependencies.audit, {
        eventType: "billing.account_resolution.denied",
        targetType: "billing",
        actorUserId: command.operatorId,
        payload: {
          action: command.action,
          accountKey: command.accountKey,
          reasonCode,
        },
      });
    }
    return { status: "refused", reasonCode, detail };
  }

  return {
    async recordResolution(input: unknown): Promise<AccountResolutionOutcome> {
      // --- The shape gate: every field, closed vocabularies, bounded lengths.
      const raw = input as Record<string, unknown> | null;
      const command: AccountResolutionCommand | null =
        raw !== null && typeof raw === "object"
          ? {
              accountKey: raw.accountKey as string,
              action: raw.action as AccountResolutionAction,
              reasonCode: raw.reasonCode as string,
              evidence: raw.evidence as AccountResolutionCommand["evidence"],
              operatorId: raw.operatorId as string,
              idempotencyKey: raw.idempotencyKey as string,
              amountCents: raw.amountCents as number | undefined,
              detail: raw.detail as string,
            }
          : null;
      if (
        !command ||
        !isNonEmptyIdentifier(command.accountKey, 256) ||
        !(ACCOUNT_RESOLUTION_ACTIONS as readonly string[]).includes(
          command.action,
        ) ||
        typeof command.reasonCode !== "string" ||
        !REASON_CODE_SHAPE.test(command.reasonCode) ||
        command.evidence === null ||
        typeof command.evidence !== "object" ||
        !(ACCOUNT_RESOLUTION_EVIDENCE_KINDS as readonly string[]).includes(
          command.evidence?.kind,
        ) ||
        !isNonEmptyIdentifier(command.evidence?.reference, 256) ||
        !isNonEmptyIdentifier(command.operatorId, 256) ||
        !isNonEmptyIdentifier(command.idempotencyKey, 256) ||
        typeof command.detail !== "string" ||
        command.detail.length === 0 ||
        command.detail.length > MAX_DETAIL_LENGTH ||
        (command.amountCents !== undefined &&
          (!Number.isSafeInteger(command.amountCents) ||
            command.amountCents <= 0))
      ) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "command" },
        };
      }
      // A refund is money leaving: it must say how much. The other actions may be
      // record-only decisions the evidence itself quantifies.
      if (command.action === "refund" && command.amountCents === undefined) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: { field: "amountCents", rule: "refund requires an amount" },
        };
      }

      // --- The replay read: the same key answers the recorded row, nothing written.
      const [existing] = await database
        .select()
        .from(billingAccountResolutions)
        .where(
          eq(billingAccountResolutions.idempotencyKey, command.idempotencyKey),
        )
        .limit(1);
      if (existing) {
        // The recorded row IS the command's answer — including when the retry carries a
        // slightly different body: the key is the identity, and a second registration of
        // one command is exactly what the table exists to prevent.
        return { status: "replayed", resolution: existing };
      }

      // --- Authorization: the seam's verdict, then the refused command's own audit row.
      const authorized = await dependencies.authorize(command.operatorId);
      if (!authorized) {
        return refuseWithAudit(command, "unauthorized", {
          operatorId: command.operatorId,
        });
      }

      // --- The refund ceiling: paid facts on the account's OWN orders, minus the
      // refunds already registered for the account. Orders attribute through their
      // owner pair matched against the payer mapping — the same join the account pass
      // uses, so the ceiling and the anomaly list can never disagree about ownership.
      // An order with no owner pair (or one whose mapping names a different account)
      // does not match the join, and its money is not refundable through this seam.
      if (command.action === "refund") {
        const [paidTotals] = await database
          .select({
            total: sql<string>`COALESCE(SUM(${paymentEvents.amountCents}), 0)::bigint`,
          })
          .from(paymentEvents)
          .innerJoin(paymentOrders, eq(paymentEvents.orderId, paymentOrders.id))
          .innerJoin(
            payerAccounts,
            and(
              eq(payerAccounts.kind, paymentOrders.ownerPayerKind),
              eq(payerAccounts.payerId, paymentOrders.ownerPayerId),
              eq(payerAccounts.externalCustomerId, command.accountKey),
            ),
          )
          .where(
            and(
              eq(paymentEvents.kind, "fact"),
              eq(paymentEvents.state, "paid"),
              eq(paymentOrders.status, "paid"),
            ),
          );
        const [refundTotals] = await database
          .select({
            total: sql<string>`COALESCE(SUM(${billingAccountResolutions.amountCents}), 0)::bigint`,
          })
          .from(billingAccountResolutions)
          .where(
            and(
              eq(
                billingAccountResolutions.externalCustomerId,
                command.accountKey,
              ),
              eq(billingAccountResolutions.action, "refund"),
            ),
          );
        const refundable =
          BigInt(paidTotals?.total ?? "0") - BigInt(refundTotals?.total ?? "0");
        if (BigInt(command.amountCents ?? 0) > refundable) {
          return refuseWithAudit(command, "refund_ceiling_exceeded", {
            refundableCents: Number(refundable),
            requestedCents: command.amountCents ?? null,
          });
        }
      }

      const id = `bar-${randomBytes(8).toString("hex")}`;
      const [row] = await database
        .insert(billingAccountResolutions)
        .values({
          id,
          externalCustomerId: command.accountKey,
          action: command.action,
          reasonCode: command.reasonCode,
          evidenceKind: command.evidence.kind,
          evidenceReference: command.evidence.reference,
          operatorId: command.operatorId,
          idempotencyKey: command.idempotencyKey,
          amountCents: command.amountCents ?? null,
          detail: command.detail,
        })
        // The replay read above is not atomic with this insert: two concurrent retries of
        // one key both miss it and both insert. The unique index decides, and the loser
        // answers the winner's row — exactly what the replay read would have answered.
        .onConflictDoNothing({
          target: billingAccountResolutions.idempotencyKey,
        })
        .returning();

      if (!row) {
        const [winner] = await database
          .select()
          .from(billingAccountResolutions)
          .where(
            eq(
              billingAccountResolutions.idempotencyKey,
              command.idempotencyKey,
            ),
          )
          .limit(1);
        if (!winner) {
          // Rows under this key are never deleted, so the key cannot be missing unless the
          // invariant already broke; failing loudly beats answering "nothing happened".
          throw new Error(
            `billing account resolution ${command.idempotencyKey} conflicted but is not readable`,
          );
        }
        return { status: "replayed", resolution: winner };
      }

      if (dependencies.audit) {
        await recordAuditEvent(dependencies.audit, {
          eventType: "billing.account_resolution.recorded",
          targetType: "billing",
          actorUserId: command.operatorId,
          payload: {
            resolutionId: id,
            action: command.action,
            accountKey: command.accountKey,
            reasonCode: command.reasonCode,
            evidenceKind: command.evidence.kind,
          },
        });
      }

      return { status: "registered", resolution: row };
    },

    async resolutionsOf(accountKey: string) {
      return database
        .select()
        .from(billingAccountResolutions)
        .where(eq(billingAccountResolutions.externalCustomerId, accountKey))
        .orderBy(
          billingAccountResolutions.createdAt,
          billingAccountResolutions.id,
        );
    },
  };
}
