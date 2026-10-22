import { and, asc, count, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { botServices } from "../db/schema/bot-services";
import {
  creditSettlementDimensionBreakdown,
  creditReservationAttribution,
  creditReservations,
  creditSettlementDetails,
  creditSpeechSettlementDetails,
} from "../db/schema/credit-reservations";
import { creditGrants, creditLedger } from "../db/schema/credits";
import { type GrantCapacity, liveGrants, readCapacity } from "./capacity";
import { type PayerRef, payerKey } from "./payer";
import type {
  CreditConsumptionPage,
  CreditGrantEntry,
  CreditGrantStatus,
  CreditReservationEntry,
  CreditSummary,
  PendingSettlementSummary,
  PersonalCreditBalance,
  PlanCatalogEntry,
} from "./types";

/**
 * The local credit ledger — the "套餐与积分" page's whole answer.
 *
 * Credits are the deployment's own currency, kept entirely in this deployment's database (the
 * confirmed split: Lago owns the subscription and the metered raw events, the credit ledger is
 * local). One credit is stored as `CREDIT_SCALE` whole units, the same "never store money as a
 * float" rule the payment orders keep, so a grant of "23.63" is the integer `2363` and never a
 * binary float that drifts.
 *
 * All three reads are scoped to one account key, and the caller cannot spell one: the account
 * rides in as a `PayerRef` — the payer resolution module's output, never a caller-supplied
 * externalCustomerId (ticket 02.4's parameter convergence). Omitting the ref reads the
 * deployment's own key, the reads the 套餐与积分 page answers today; ticket 02.6 switches the
 * person-facing routes to the signed-in user's resolved personal ref. `status` and `expiringSoon`
 * are derived here, not stored, because "used up" and "expired" are functions of the clock and
 * the balance, not facts a writer must remember to flip; the page never shows a stale pill.
 */

/** One credit = this many stored units, so the two-place decimals stay exact. */
export const CREDIT_SCALE = 100;

/** How many ledger rows a page holds. Ours, not the caller's — the same rule as the event log. */
const CONSUMPTION_PAGE_SIZE = 20;

/** The window a consumption read is narrowed to. Both ends inclusive, either end optional. */
export type CreditConsumptionWindow = {
  from: Date | null;
  to: Date | null;
  page: number;
};

export type Credits = {
  /** The plan catalog this deployment configured, for the upgrade dialog. */
  catalog: ReadonlyMap<string, PlanCatalogEntry>;
  /**
   * The personal read (ticket 02.6): the payer's own account type, available/consumed/expired
   * and held, every grant with its derived life, and the pending-settlement placeholders. Reads
   * only — no write door exists on this path.
   */
  personalBalance(payer: PayerRef): Promise<PersonalCreditBalance>;
  summary(payer?: PayerRef): Promise<CreditSummary>;
  grants(payer?: PayerRef): Promise<readonly CreditGrantEntry[]>;
  consumption(
    window: CreditConsumptionWindow,
    payer?: PayerRef,
  ): Promise<CreditConsumptionPage>;
};

/**
 * How many reservation rows the pending view itemizes. Ours, not the caller's — the same rule
 * as the consumption page's size: the quota stays exact over ALL rows (the aggregates below),
 * while the list is the account's latest window.
 */
const RESERVATION_VIEW_LIMIT = 20;

export function createCredits(deps: {
  database: Database;
  /** The deployment's own customer key, so the read needs no explicit caller. */
  externalCustomerKey: string;
  /** The plan catalog from deployment config, passed through for the upgrade dialog. */
  catalog: ReadonlyMap<string, PlanCatalogEntry>;
}): Credits {
  const { database, externalCustomerKey, catalog } = deps;
  // The one place a read's account key is decided: from the resolved payer ref, or the
  // deployment's own key when no ref was resolved. A bare externalCustomerId cannot reach here
  // — the parameter is a PayerRef or nothing (02.4's convergence).
  const keyOf = (payer?: PayerRef) =>
    payer ? payerKey(payer) : externalCustomerKey;

  return {
    catalog,
    async personalBalance(payer) {
      const key = payerKey(payer);
      // One clock for the whole answer: grant liveness, the expired filter and the derived
      // statuses bind to the same instant, so the four numbers cannot disagree about now.
      const at = new Date();
      // The live side from the one capacity definition admission uses (audit A1): `available` is
      // the writer's own spendable figure, `held` the open holds, and the grants carry what the
      // page would let you spend per grant.
      const capacity = await readCapacity(database, key, at);
      // The expired side, with the same clock: what lapsed grants absorbed and what they took
      // with them unused. Consumed spans both sides — a charge stays consumed after its grant
      // expires, so the expired figure must be the lapsed REMAINDER, never the grant total.
      const [lapsed] = await database
        .select({
          used: sql<number>`coalesce(sum(${creditGrants.used}), 0)::int`,
          unused: sql<number>`coalesce(sum(greatest(${creditGrants.total} - ${creditGrants.used}, 0)), 0)::int`,
        })
        .from(creditGrants)
        .where(
          and(
            eq(creditGrants.externalCustomerId, key),
            lte(creditGrants.expiresAt, at),
          ),
        );
      const rows = await database
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.externalCustomerId, key))
        .orderBy(asc(creditGrants.expiresAt));
      const now = at.getTime();
      const soon = now + 24 * 60 * 60 * 1000;
      const liveUsed = capacity.grants.reduce(
        (sum, grant) => sum + grant.used,
        0,
      );
      const held = capacity.grants.reduce((sum, grant) => sum + grant.held, 0);
      return {
        accountType: "personal",
        available: scaleDown(capacity.spendableUnits),
        consumed: scaleDown(liveUsed + Number(lapsed?.used ?? 0)),
        expired: scaleDown(Number(lapsed?.unused ?? 0)),
        held: scaleDown(held),
        grants: rows.map((row) => grantOf(row, now, soon)),
        pendingSettlement: await pendingSettlementOf(database, key, at),
      };
    },

    async summary(payer) {
      // The same live-grant read admission uses, unlocked: expired grants drop out and active
      // holds are subtracted, so this answer and the gate's answer cannot disagree (audit A1).
      const grants = await liveGrants(
        database,
        keyOf(payer),
        new Date(),
        false,
      );
      return summarizeCapacity(grants);
    },

    async grants(payer) {
      const rows = await database
        .select()
        .from(creditGrants)
        .where(
          and(
            eq(creditGrants.externalCustomerId, keyOf(payer)),
            ne(creditGrants.source, "plan"),
          ),
        )
        // Soonest-to-lapse first, so the red "24小时内过期" cue leads the list.
        .orderBy(asc(creditGrants.expiresAt));

      const now = Date.now();
      const soon = now + 24 * 60 * 60 * 1000;
      return rows.map((row) => grantOf(row, now, soon));
    },

    async consumption(window, payer) {
      const conditions = [eq(creditLedger.externalCustomerId, keyOf(payer))];
      if (window.from)
        conditions.push(gte(creditLedger.createdAt, window.from));
      if (window.to) conditions.push(lte(creditLedger.createdAt, window.to));
      const where = and(...conditions);

      const totalCount = await database
        .select({ value: count() })
        .from(creditLedger)
        .where(where)
        .then((rows) => rows[0]?.value ?? 0);

      const rows = await database
        .select({
          id: creditLedger.id,
          title: creditLedger.title,
          requestId: creditLedger.requestId,
          credits: creditLedger.credits,
          applied: creditLedger.applied,
          model: creditLedger.model,
          client: creditLedger.client,
          createdAt: creditLedger.createdAt,
          botId: creditReservationAttribution.botId,
          botName: botServices.displayName,
          lineCapability: creditSettlementDetails.capability,
          lineRequestedCount: creditSettlementDetails.requestedCount,
          lineGeneratedCount: creditSettlementDetails.generatedCount,
          lineSize: creditSettlementDetails.size,
          lineQuality: creditSettlementDetails.quality,
          speechCapability: creditSpeechSettlementDetails.capability,
          speechInputCharacters: creditSpeechSettlementDetails.inputCharacters,
          speechCappedSeconds: creditSpeechSettlementDetails.cappedSeconds,
          speechActualSeconds: creditSpeechSettlementDetails.actualSeconds,
          speechVoiceTier: creditSpeechSettlementDetails.voiceTier,
        })
        .from(creditLedger)
        // The attribution walk: a reservation-born ledger row (the writer records
        // `credit_reservations.ledger_id`) names its reservation, the reservation's
        // attribution names the Bot. Writer-direct rows join nothing and stay null.
        .leftJoin(
          creditReservations,
          eq(creditReservations.ledgerId, creditLedger.id),
        )
        .leftJoin(
          creditReservationAttribution,
          eq(creditReservationAttribution.reservationId, creditReservations.id),
        )
        .leftJoin(
          botServices,
          eq(botServices.botId, creditReservationAttribution.botId),
        )
        // The line detail (12.2): a capability settlement's ledger row carries the line
        // it settled as — the image spec and counts — keyed by the same reservation.
        // Rows without one (every non-capability charge) join nothing and stay null.
        .leftJoin(
          creditSettlementDetails,
          eq(creditSettlementDetails.ledgerId, creditLedger.id),
        )
        // The speech line (13.2) joins the same way through its own table: a ledger row
        // carries exactly one capability's line, whichever table holds it.
        .leftJoin(
          creditSpeechSettlementDetails,
          eq(creditSpeechSettlementDetails.ledgerId, creditLedger.id),
        )
        .where(where)
        .orderBy(desc(creditLedger.createdAt))
        .limit(CONSUMPTION_PAGE_SIZE)
        .offset((window.page - 1) * CONSUMPTION_PAGE_SIZE);

      const totalPages = Math.max(
        Math.ceil(totalCount / CONSUMPTION_PAGE_SIZE),
        1,
      );

      // The per-dimension split (20.3), read for exactly this page's rows — never a fan-out
      // join over the paginated ledger read. A settlement that wrote no split answers no
      // split (undefined below): the UI shows no surcharge line for it, never a zero that
      // would read as "tools were free".
      const splitRows = await database
        .select({
          ledgerId: creditSettlementDimensionBreakdown.ledgerId,
          dimension: creditSettlementDimensionBreakdown.dimension,
          units: creditSettlementDimensionBreakdown.units,
        })
        .from(creditSettlementDimensionBreakdown)
        .where(
          inArray(
            creditSettlementDimensionBreakdown.ledgerId,
            rows.map((row) => row.id),
          ),
        );
      const splitByLedger = new Map<string, typeof splitRows>();
      for (const split of splitRows) {
        const members = splitByLedger.get(split.ledgerId) ?? [];
        members.push(split);
        splitByLedger.set(split.ledgerId, members);
      }
      const feeBreakdownOf = (ledgerId: string) => {
        const members = splitByLedger.get(ledgerId);
        if (members === undefined || members.length === 0) return undefined;
        let model = 0;
        let surcharge = 0;
        for (const member of members) {
          if (member.dimension.startsWith("surcharge_")) surcharge += member.units;
          else model += member.units;
        }
        return {
          modelCredits: scaleDown(model),
          surchargeCredits: scaleDown(surcharge),
        };
      };

      return {
        entries: rows.map((row) => ({
          id: row.id,
          title: row.title,
          requestId: row.requestId,
          credits: scaleDown(row.credits),
          applied: scaleDown(row.applied),
          model: row.model,
          client: row.client,
          // 06.12's attribution: the ledger row born of a protocol-settled reservation names
          // the Bot the reserve ran for; every other row stays unattributed, never guessed.
          botId: row.botId,
          botName: row.botName,
          // 12.2's line detail: a capability settlement's entry shows what was consumed —
          // the image spec and counts, distinguishable from every other capability — with
          // the amount this entry already carries. Other rows carry no line at all.
          lineDetail:
            row.lineCapability === "image"
              ? {
                  capability: row.lineCapability,
                  image: {
                    size: row.lineSize,
                    quality: row.lineQuality,
                    requestedCount: row.lineRequestedCount,
                    generatedCount: row.lineGeneratedCount,
                  },
                }
              : row.speechCapability === "speech"
                ? // 13.2's speech line: the characters in, the seconds out — the entry a
                  // speech consumption shows, distinguishable from image and chat.
                  {
                    capability: row.speechCapability,
                    speech: {
                      inputCharacters: row.speechInputCharacters,
                      voiceTier: row.speechVoiceTier,
                      cappedSeconds: row.speechCappedSeconds,
                      actualSeconds: row.speechActualSeconds,
                    },
                  }
                : null,
          // 20.3's fee split: model fee and surcharge fee of THIS entry, whole scaled
          // units of the ledger row it explains — absent when the settlement wrote no
          // split, and never a zero surcharge line the UI would read as "free tools".
          feeBreakdown: feeBreakdownOf(row.id),
          timestamp: row.createdAt.toISOString(),
        })),
        pagination: {
          totalCount,
          totalPages,
          currentPage: window.page,
          nextPage:
            window.page * CONSUMPTION_PAGE_SIZE < totalCount
              ? window.page + 1
              : null,
        },
      };
    },
  };
}

/**
 * The pending-settlement answer (ticket 06.12), computed over the account's OWN reservation
 * rows with the SAME clock the rest of the balance binds to. The quota counts exactly the
 * holds admission still occupies (./capacity.ts's occupying set): an unexpired plain
 * `reserved` hold and every `unknown` one — an unknown hold occupies no matter how far the
 * clock runs past `expires_at`, and a lapsed plain hold has stopped occupying, so it moves to
 * `expired` (visible for reconciliation, never counted as spendable or pending). `consumed`
 * sums what settled reservations charged — the same integer the ledger wrote — so the page's
 * number and the ledger's can never disagree. Every amount is an aggregate over ALL of the
 * account's rows; only the itemized list below is bounded.
 */
async function pendingSettlementOf(
  database: Database,
  key: string,
  at: Date,
): Promise<PendingSettlementSummary> {
  const [buckets] = await database
    .select({
      reserved: sql<number>`coalesce(sum(${creditReservations.maximum}) filter (where ${creditReservations.status} = 'reserved' and ${creditReservations.expiresAt} > ${at}), 0)::int`,
      unknown: sql<number>`coalesce(sum(${creditReservations.maximum}) filter (where ${creditReservations.status} = 'unknown'), 0)::int`,
      consumed: sql<number>`coalesce(sum(${creditReservations.charged}) filter (where ${creditReservations.status} = 'settled'), 0)::int`,
      expired: sql<number>`coalesce(sum(${creditReservations.maximum}) filter (where ${creditReservations.status} = 'reserved' and ${creditReservations.expiresAt} <= ${at}), 0)::int`,
    })
    .from(creditReservations)
    .where(eq(creditReservations.externalCustomerId, key));

  const rows = await database
    .select({
      id: creditReservations.id,
      status: creditReservations.status,
      maximum: creditReservations.maximum,
      charged: creditReservations.charged,
      released: creditReservations.released,
      provider: creditReservations.provider,
      model: creditReservations.model,
      capability: creditReservations.capability,
      unknownReason: creditReservations.unknownReason,
      releaseReason: creditReservations.releaseReason,
      createdAt: creditReservations.createdAt,
      expiresAt: creditReservations.expiresAt,
      terminalAt: creditReservations.terminalAt,
      botId: creditReservationAttribution.botId,
      botName: botServices.displayName,
    })
    .from(creditReservations)
    .leftJoin(
      creditReservationAttribution,
      eq(creditReservationAttribution.reservationId, creditReservations.id),
    )
    .leftJoin(
      botServices,
      eq(botServices.botId, creditReservationAttribution.botId),
    )
    .where(eq(creditReservations.externalCustomerId, key))
    // Newest first, id as the tiebreaker so same-instant rows still order stably.
    .orderBy(desc(creditReservations.createdAt), desc(creditReservations.id))
    .limit(RESERVATION_VIEW_LIMIT);

  const reservations: CreditReservationEntry[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    maximum: scaleDown(row.maximum),
    charged: row.charged === null ? null : scaleDown(row.charged),
    released: row.released === null ? null : scaleDown(row.released),
    provider: row.provider,
    model: row.model,
    capability: row.capability,
    botId: row.botId,
    botName: row.botName,
    unknownReason: row.unknownReason,
    releaseReason: row.releaseReason,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    terminalAt: row.terminalAt?.toISOString() ?? null,
  }));

  const reserved = Number(buckets?.reserved ?? 0);
  const unknown = Number(buckets?.unknown ?? 0);
  return {
    enabled: true,
    available: scaleDown(reserved + unknown),
    consumed: scaleDown(Number(buckets?.consumed ?? 0)),
    expired: scaleDown(Number(buckets?.expired ?? 0)),
    reserved: scaleDown(reserved),
    unknown: scaleDown(unknown),
    reservations,
  };
}

/**
 * The page's balance answer, from the same per-grant capacity facts admission uses. Pure, so the
 * aggregation is testable without a database (audit A1: the previous version was reachable only
 * through a live query and had no test at all).
 */
export function summarizeCapacity(
  grants: readonly GrantCapacity[],
): CreditSummary {
  const plan = { total: 0, used: 0, remaining: 0, held: 0 };
  const rewards = { total: 0, used: 0, remaining: 0, held: 0, grantCount: 0 };
  for (const grant of grants) {
    const bucket = grant.source === "plan" ? plan : rewards;
    bucket.total += grant.total;
    bucket.used += grant.used;
    bucket.held += grant.held;
    bucket.remaining += grant.free;
    if (grant.source !== "plan" && grant.free > 0) rewards.grantCount += 1;
  }
  return {
    plan: {
      total: scaleDown(plan.total),
      used: scaleDown(plan.used),
      remaining: scaleDown(plan.remaining),
      held: scaleDown(plan.held),
    },
    rewards: {
      total: scaleDown(rewards.total),
      used: scaleDown(rewards.used),
      remaining: scaleDown(rewards.remaining),
      held: scaleDown(rewards.held),
      grantCount: rewards.grantCount,
    },
  };
}

/**
 * A grant's life, derived from its balance and its expiry — never stored, because "used up" and
 * "expired" are functions of the clock and the balance, not facts a writer must remember to flip.
 * Exported for the tests that pin the three-way state machine.
 */
export function deriveGrantStatus(
  grant: { total: number; used: number; expiresAt: Date },
  now: number,
): CreditGrantStatus {
  const remaining = Math.max(grant.total - grant.used, 0);
  return grant.expiresAt.getTime() <= now
    ? "expired"
    : remaining <= 0
      ? "exhausted"
      : "active";
}

/** The stored row → the page's entry, the two-place decimal restored and the life derived. */
function grantOf(
  row: typeof creditGrants.$inferSelect,
  now: number,
  soon: number,
): CreditGrantEntry {
  const remaining = Math.max(row.total - row.used, 0);
  const status = deriveGrantStatus(row, now);
  return {
    id: row.id,
    source: row.source,
    reason: row.reason,
    total: scaleDown(row.total),
    used: scaleDown(row.used),
    remaining: scaleDown(remaining),
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status,
    expiringSoon: status === "active" && row.expiresAt.getTime() <= soon,
  };
}

/** Stored units → credits, a decimal with two places. */
function scaleDown(units: number): number {
  return units / CREDIT_SCALE;
}
