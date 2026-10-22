/*
 * The batch submit path (Bifrost 18.1, #333): one submit = one whole-batch reservation =
 * one batch + N item identities, dispatched only after the hold exists — the async
 * family's 17.2 discipline, carried to a batch whose items may price DIFFERENTLY.
 *
 * THE CAP IS THE WHOLE BATCH'S WORST CASE, PRICED PER ITEM. Every item's certified
 * worst-case quantities are priced on the item's OWN model cell at the batch's locked
 * versions (mixed models mean mixed unit prices — never one price × N), and the per-item
 * EXACT costs are summed as rationals with the ONE upward rounding at the very end. A
 * dimension any item's basis prices `unknown` refuses the submit, and the refusal names
 * the dimension: a batch that cannot be priced completely cannot be capped, so it is not
 * dispatched.
 *
 * THE HOLD PRECEDES THE DISPATCH, AND IT IS ONE. The reserve door admits ONE model cell
 * per call, so the submit walks the batch's DISTINCT cells and calls the door for each
 * under the SAME submit idempotency key and the SAME whole-batch cap: the first call
 * creates the hold, every later call re-runs that cell's own admission (grant, open
 * scope, catalog freshness, known prices — each cell gets door-grade admission) and then
 * replays the SAME hold by the door's own idempotency semantics. Exactly one reservation
 * exists for the batch, and the reservation's basis lock names the batch's anchor cell
 * (the first distinct cell admitted) — a true resolvable basis, but not the batch's price
 * basis: settlement prices from the item rows, never from the hold's lock.
 *
 * ALL-OR-NOTHING, INCLUDING THE COMPENSATION. A refusal on ANY cell refuses the WHOLE
 * batch: the hold an earlier cell's admission already built is handed back before the
 * submit answers (the release's evidence is the sibling admission refusal itself —
 * admission refused before the provider was called, the `bound_refused` vocabulary's own
 * meaning; the provider dispatch count is ZERO, so nothing was ever at cost). An
 * insufficient balance refuses on the first call, before any hold exists. There is no
 * state in which part of the batch dispatched and part is still reserving: the cap is
 * fixed at creation, the submit key is the only door, and a replay answers the SAME cap —
 * "不允许部分派发后再追加预留" is structural (no API grows a reservation), not a checked
 * rule.
 *
 * IDENTITY IS FIXED AT CREATION, PARENT AND CHILD ALIKE. The batch row copies the grant,
 * the resolved payer and both locked versions; each item row copies its own model cell,
 * its certified quantities and the caller's `custom_id` (the key the provider's per-item
 * results arrive keyed by). The child carries no payer of its own — its attribution IS
 * the parent's, by construction. `providerBatchId` may stay absent when the dispatch
 * answer is lost: the row records `dispatch_unconfirmed`, the reservation moves to 06.8's
 * `unknown` with its FULL cap still occupied the moment the loss is known, and nothing
 * about a missing provider id is read as evidence of no cost.
 *
 * The same request-shape discipline as the credit protocol: account-identity and
 * company-scope fields are refused at the boundary — presence is the attempt.
 */

import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { accessGrants } from "../db/schema";
import { batchItems, batchJobs } from "../db/schema/credit-reservations";
import { PRICE_DIMENSIONS, type PriceDimension } from "../gateway/price-snapshot";
import {
  RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS,
  type CreditReserveOutcome,
  type CreditReserveRequest,
} from "./credit-reserve";
import { createCreditWriter } from "./credits-writer";
import { computeReservationCeiling } from "./reserve-bound";
import { findCompanyScopeIdentityField } from "./personal-key-isolation";

/** The local batch/item ids' prefixes — recognisable on sight, like the reservation's `cr-`. */
export const BATCH_ID_PREFIX = "bj-";
export const BATCH_ITEM_ID_PREFIX = "bi-";

/** How the submit's own refusals answer — a closed vocabulary, one sentence each. */
export type BatchSubmitRefusalReasonCode =
  | "request_invalid"
  | "price_unknown"
  | "reserve_refused";

/** Why the dispatch answer is absent, when it is — the async family's 17.3 lane. */
export type BatchDispatchOutcome =
  | { kind: "answered"; providerBatchId: string }
  | { kind: "lost"; reason: string };

/** One item's certified worst-case quantities: whole, non-negative, per billing dimension. */
export type BatchSubmitItemQuantities = Partial<
  Record<PriceDimension, number>
>;

/** One item of the submit: its own model cell, its caller identity, its worst case. */
export type BatchSubmitItem = {
  /** The caller's per-item identity; the provider's per-item results arrive keyed by it. */
  readonly customId: string;
  readonly model: {
    provider: string;
    model: string;
    capability: string;
  };
  readonly quantities: BatchSubmitItemQuantities;
};

/** The submit request's shape — every field is server-verified, none client-trusted. */
export type BatchSubmitRequest = {
  /** The submit's stable identity, from the caller's own durable request (not a timestamp). */
  readonly submitIdempotencyKey: string;
  readonly grantId: string;
  /** A claim the reserve door verifies against the grant's server-side resolution (06.4). */
  readonly payer: { kind: string; id: string };
  readonly snapshotVersion: number;
  readonly rateVersion: number;
  readonly items: readonly BatchSubmitItem[];
  readonly expiresAt?: Date | string;
};

/** What a submit answers: the one batch (created or already existing), or a refusal. */
export type BatchSubmitOutcome =
  | {
      status: "submitted";
      /** True when this call created the batch; false when a replay answered the existing one. */
      created: boolean;
      batchId: string;
      reservationId: string;
      maximumCredits: number;
      itemCount: number;
      /** Dispatch's own outcome; the terminal members (18.3) name a settled batch. */
      state:
        | "submitted"
        | "dispatch_unconfirmed"
        | "partial"
        | "completed"
        | "failed"
        | "cancelled";
      providerBatchId: string | null;
      /** The minted item identities, in submit order — the parent/child identity contract. */
      items: readonly { itemId: string; customId: string }[];
    }
  | {
      status: "refused";
      reasonCode: BatchSubmitRefusalReasonCode;
      detail: Record<string, unknown>;
    };

/** The seams the submit path composes — production wires 06.2 and the dispatch client. */
export type BatchSubmitServiceDependencies = {
  database: Database;
  /** The reserve door: called once per DISTINCT cell, all under the submit's own key. */
  reserve: (request: CreditReserveRequest) => Promise<CreditReserveOutcome>;
  /** The provider batch dispatch: called at most once per batch, by the submit that created it. */
  dispatch: (input: {
    batchId: string;
    reservationId: string;
    submitIdempotencyKey: string;
  }) => Promise<BatchDispatchOutcome>;
  /**
   * 06.8's unknown mark, fired the moment a dispatch answer is known lost — the hold keeps
   * its FULL cap and the recovery lane takes over. Defaults to the credit writer's own
   * transition; injected only by tests.
   */
  markUnknown?: (reservationId: string, reason: string) => Promise<void>;
  /**
   * The compensation release for a sibling cell's admission refusal — the hold an earlier
   * cell built is handed back (admission refused before the provider was called). Defaults
   * to the credit writer's release; injected only by tests.
   */
  release?: (reservationId: string, reason: string) => Promise<void>;
  /** The locked basis's dims and rate — resolved by the caller from the same versions. */
  resolveBasis: (model: {
    provider: string;
    model: string;
    capability: string;
    snapshotVersion: number;
    rateVersion: number;
  }) => Promise<
    | {
        ok: true;
        dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
        rate: Parameters<typeof computeReservationCeiling>[0]["rate"];
      }
    | { ok: false; reason: "price_basis_not_found"; detail?: Record<string, unknown> }
  >;
  now?: () => Date;
};

/** An exact rational cost, lowest terms not required here (the sum reduces at the end). */
type ExactRational = { numerator: bigint; denominator: bigint };

/** Add two exact rationals by cross-multiplication — no rounding anywhere. */
function addExact(
  a: ExactRational,
  b: ExactRational,
): ExactRational {
  return {
    numerator: a.numerator * b.denominator + b.numerator * a.denominator,
    denominator: a.denominator * b.denominator,
  };
}

/** ceil(numerator/denominator) for non-negative rationals — the ONE rounding the cap takes. */
function ceilExact(value: ExactRational): bigint {
  if (value.numerator === 0n) return 0n;
  return (
    (value.numerator + value.denominator - 1n) / value.denominator
  );
}

/** Largest value the ledger's 32-bit integer columns can held, in stored units. */
const MAX_STORED_UNITS = 2_147_483_647n;

/** One item's quantities, normalized to the full dimension vocabulary (absent = 0). */
function fullQuantitiesOf(
  quantities: BatchSubmitItemQuantities,
): Record<PriceDimension, number> | { invalid: string } {
  const full = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [dimension, 0]),
  ) as Record<PriceDimension, number>;
  for (const [dimension, quantity] of Object.entries(quantities ?? {})) {
    if (!PRICE_DIMENSIONS.includes(dimension as PriceDimension)) {
      return { invalid: dimension };
    }
    if (
      typeof quantity !== "number" ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0
    ) {
      return { invalid: dimension };
    }
    full[dimension as PriceDimension] = quantity;
  }
  return full;
}

/**
 * The whole-batch cap conversion: every item priced on its OWN cell's dims, the exact
 * costs summed as rationals, ONE upward rounding at the end. Pure — the same items, dims
 * and rates always certify the same cap, so a re-derived cap agrees with the stored one.
 */
export function computeBatchCap(input: {
  items: readonly {
    quantities: BatchSubmitItemQuantities;
    dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
    rate: Parameters<typeof computeReservationCeiling>[0]["rate"];
  }[];
}):
  | {
      ok: true;
      maximumCredits: number;
      /** Each item's exact worst-case cost, in submit order — the audit's per-item trace. */
      itemExact: ExactRational[];
      /** The summed exact cost, the ceiling's floor target. */
      totalExact: ExactRational;
    }
  | {
      ok: false;
      code: "request_invalid" | "price_unknown";
      detail: Record<string, unknown>;
    } {
  let total: ExactRational = { numerator: 0n, denominator: 1n };
  const itemExact: ExactRational[] = [];
  for (const [index, item] of input.items.entries()) {
    const full = fullQuantitiesOf(item.quantities);
    if ("invalid" in full) {
      return {
        ok: false,
        code: "request_invalid",
        detail: { field: `items[${index}].quantities.${full.invalid}` },
      };
    }
    const priced = computeReservationCeiling({
      dims: item.dims,
      quantities: full,
      rate: item.rate,
    });
    if (!priced.ok) {
      const issue = priced.issue;
      switch (issue.code) {
        case "price_unknown":
          return {
            ok: false,
            code: "price_unknown",
            detail: {
              item: index,
              dimension: issue.dimension,
              reason: issue.reason,
            },
          };
        case "quantity_invalid":
          return {
            ok: false,
            code: "request_invalid",
            detail: { field: `items[${index}].quantities.${issue.dimension}` },
          };
        case "rate_invalid":
        case "ceiling_exceeds_ledger":
          return { ok: false, code: "price_unknown", detail: { reason: issue.code } };
      }
    }
    itemExact.push(priced.exactScaledUnits);
    total = addExact(total, priced.exactScaledUnits);
  }
  const ceiling = ceilExact(total);
  if (ceiling > MAX_STORED_UNITS) {
    return {
      ok: false,
      code: "price_unknown",
      detail: { reason: "ceiling_exceeds_ledger" },
    };
  }
  return {
    ok: true,
    maximumCredits: Number(ceiling),
    itemExact,
    totalExact: total,
  };
}

function isIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

/**
 * Pure shape validation, the protocol doors' own discipline: closed fields, the payer claim
 * exactly {kind, id}, the account/company-scope vocabulary refused on presence, and each
 * item a closed {customId, model, quantities} triple.
 */
function validateSubmitRequest(
  input: unknown,
): { ok: true; request: BatchSubmitRequest } | { ok: false; detail: Record<string, unknown> } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, detail: { field: "body" } };
  }
  const raw = input as Record<string, unknown>;
  if (!isIdentifier(raw.submitIdempotencyKey, 512)) {
    return { ok: false, detail: { field: "submitIdempotencyKey" } };
  }
  if (!isIdentifier(raw.grantId, 512)) {
    return { ok: false, detail: { field: "grantId" } };
  }
  const payer = raw.payer as Record<string, unknown> | null | undefined;
  if (
    payer === null ||
    typeof payer !== "object" ||
    typeof payer.kind !== "string" ||
    !isIdentifier(payer.id, 512)
  ) {
    return { ok: false, detail: { field: "payer" } };
  }
  const extraPayerKey = Object.keys(payer).find(
    (key) => key !== "kind" && key !== "id",
  );
  if (extraPayerKey !== undefined) {
    return { ok: false, detail: { field: `payer.${extraPayerKey}` } };
  }
  const forbidden = new Set(
    RESERVE_FORBIDDEN_ACCOUNT_KEY_FIELDS.map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(raw)) {
    if (forbidden.has(key.toLowerCase()) || findCompanyScopeIdentityField({ [key]: true })) {
      return { ok: false, detail: { field: key } };
    }
  }
  if (
    !Number.isSafeInteger(raw.snapshotVersion) ||
    (raw.snapshotVersion as number) < 1 ||
    !Number.isSafeInteger(raw.rateVersion) ||
    (raw.rateVersion as number) < 0
  ) {
    return { ok: false, detail: { field: "snapshotVersion" } };
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    return { ok: false, detail: { field: "items" } };
  }
  const customIds = new Set<string>();
  for (const [index, rawItem] of (raw.items as unknown[]).entries()) {
    if (rawItem === null || typeof rawItem !== "object") {
      return { ok: false, detail: { field: `items[${index}]` } };
    }
    const item = rawItem as Record<string, unknown>;
    const extraKey = Object.keys(item).find(
      (key) => key !== "customId" && key !== "model" && key !== "quantities",
    );
    if (extraKey !== undefined) {
      return { ok: false, detail: { field: `items[${index}].${extraKey}` } };
    }
    if (!isIdentifier(item.customId, 512)) {
      return { ok: false, detail: { field: `items[${index}].customId` } };
    }
    if (customIds.has(item.customId)) {
      return {
        ok: false,
        detail: { field: `items[${index}].customId`, reason: "duplicate_custom_id" },
      };
    }
    customIds.add(item.customId);
    const model = item.model as Record<string, unknown> | null | undefined;
    if (
      model === null ||
      typeof model !== "object" ||
      !isIdentifier(model.provider, 512) ||
      !isIdentifier(model.model, 512) ||
      !isIdentifier(model.capability, 64)
    ) {
      return { ok: false, detail: { field: `items[${index}].model` } };
    }
    const quantities = item.quantities;
    if (
      quantities !== undefined &&
      (quantities === null ||
        typeof quantities !== "object" ||
        Array.isArray(quantities))
    ) {
      return { ok: false, detail: { field: `items[${index}].quantities` } };
    }
  }
  return {
    ok: true,
    request: {
      submitIdempotencyKey: raw.submitIdempotencyKey,
      grantId: raw.grantId,
      payer: { kind: payer.kind, id: payer.id },
      snapshotVersion: raw.snapshotVersion as number,
      rateVersion: raw.rateVersion as number,
      items: raw.items as BatchSubmitItem[],
      ...(raw.expiresAt !== undefined
        ? { expiresAt: raw.expiresAt as Date | string }
        : {}),
    },
  };
}

/** The view of a batch row the submit answer and a replay both carry. */
type BatchRowView = {
  batchId: string;
  reservationId: string;
  maximumCredits: number;
  itemCount: number;
  state:
    | "submitted"
    | "dispatch_unconfirmed"
    | "partial"
    | "completed"
    | "failed"
    | "cancelled";
  providerBatchId: string | null;
};

function viewOf(
  row: typeof batchJobs.$inferSelect,
  items: readonly { itemId: string; customId: string }[],
): BatchRowView & { items: readonly { itemId: string; customId: string }[] } {
  return {
    batchId: row.batchId,
    reservationId: row.reservationId,
    maximumCredits: row.maximumCredits,
    itemCount: row.itemCount,
    state: row.state,
    providerBatchId: row.providerBatchId,
    items,
  };
}

/** The distinct model cells of a submit, in first-appearance order — the admission walk. */
function distinctCellsOf(
  request: BatchSubmitRequest,
): { provider: string; model: string; capability: string }[] {
  const seen = new Set<string>();
  const cells: { provider: string; model: string; capability: string }[] = [];
  for (const item of request.items) {
    const key = `${item.model.provider}\u0000${item.model.model}\u0000${item.model.capability}`;
    if (!seen.has(key)) {
      seen.add(key);
      cells.push(item.model);
    }
  }
  return cells;
}

/**
 * The submit path itself. Order is the contract: idempotency read → per-cell basis + cap
 * conversion → reserve (once per distinct cell, one hold) → batch + items insert (unique)
 * → dispatch, once, by the row's creator only.
 */
export function createBatchSubmitService(
  dependencies: BatchSubmitServiceDependencies,
) {
  const { database, reserve, dispatch, resolveBasis } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const writer = createCreditWriter(database);
  const markUnknown = dependencies.markUnknown ?? writer.markReservationUnknown;
  const release = dependencies.release ?? writer.releaseReservation;

  return {
    async submit(input: unknown): Promise<BatchSubmitOutcome> {
      const validated = validateSubmitRequest(input);
      if (!validated.ok) {
        return {
          status: "refused",
          reasonCode: "request_invalid",
          detail: validated.detail,
        };
      }
      const request = validated.request;

      // 1. The idempotency read: a replayed submit answers the existing batch — no second
      //    reservation, no second dispatch, no re-derivation of anything.
      const [existing] = await database
        .select()
        .from(batchJobs)
        .where(eq(batchJobs.submitIdempotencyKey, request.submitIdempotencyKey))
        .limit(1);
      if (existing) {
        const items = await database
          .select({ itemId: batchItems.itemId, customId: batchItems.customId })
          .from(batchItems)
          .where(eq(batchItems.batchId, existing.batchId))
          .orderBy(batchItems.itemIndex);
        return {
          status: "submitted",
          created: false,
          ...viewOf(existing, items),
        };
      }

      // 2. The per-cell basis resolution and the whole-batch cap. A cell whose basis cannot
      //    be resolved, or a dimension any item's basis prices unknown, refuses the batch
      //    before any hold or dispatch.
      const cells = distinctCellsOf(request);
      const bases = new Map<
        string,
        Awaited<ReturnType<typeof resolveBasis>>
      >();
      for (const cell of cells) {
        const basis = await resolveBasis({
          ...cell,
          snapshotVersion: request.snapshotVersion,
          rateVersion: request.rateVersion,
        });
        if (!basis.ok) {
          return {
            status: "refused",
            reasonCode: "price_unknown",
            detail: { reason: basis.reason, ...(basis.detail ?? {}) },
          };
        }
        bases.set(`${cell.provider}\u0000${cell.model}\u0000${cell.capability}`, basis);
      }
      const cap = computeBatchCap({
        items: request.items.map((item) => {
          const basis = bases.get(
            `${item.model.provider}\u0000${item.model.model}\u0000${item.model.capability}`,
          ) as {
            dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
            rate: Parameters<typeof computeReservationCeiling>[0]["rate"];
          };
          return { quantities: item.quantities, dims: basis.dims, rate: basis.rate };
        }),
      });
      if (!cap.ok) {
        return { status: "refused", reasonCode: cap.code, detail: cap.detail };
      }

      // 3. The reserve, once per DISTINCT cell under the SAME submit key and cap. The first
      //    call creates the one hold; every later call re-runs that cell's own admission
      //    (grant, open scope, freshness, known prices) and then replays the SAME hold. A
      //    refusal on any cell — balance on the first, admission on a sibling — refuses the
      //    whole batch, handing back any hold an earlier cell already built: the provider
      //    was never called, so the release stands on the admission refusal itself.
      let holdReservationId: string | undefined;
      const totals = Object.fromEntries(
        PRICE_DIMENSIONS.map((dimension) => [dimension, 0]),
      ) as Record<PriceDimension, number>;
      for (const item of request.items) {
        const full = fullQuantitiesOf(item.quantities);
        if ("invalid" in full) {
          return {
            status: "refused",
            reasonCode: "request_invalid",
            detail: { field: "items.quantities" },
          };
        }
        for (const dimension of PRICE_DIMENSIONS) {
          totals[dimension] += full[dimension];
        }
      }
      for (const [index, cell] of cells.entries()) {
        const reserved = await reserve({
          grantId: request.grantId,
          payer: request.payer as CreditReserveRequest["payer"],
          model: cell as CreditReserveRequest["model"],
          snapshotVersion: request.snapshotVersion,
          rateVersion: request.rateVersion,
          maximumCredits: cap.maximumCredits,
          idempotencyKey: request.submitIdempotencyKey,
          // The cap's own evidence: the items' counts are frozen before dispatch, so the
          // certified totals ARE the enforceable ceiling (the refusal-kind shape, 计满即拒).
          boundEvidence: [
            {
              kind: "self_enforced_input_refusal",
              maximumTokens: Math.max(
                1,
                totals.input + totals.cache_read + totals.cache_write,
              ),
            },
          ],
          ...(request.expiresAt !== undefined
            ? { expiresAt: new Date(request.expiresAt as string) }
            : {}),
        } satisfies CreditReserveRequest);
        if (reserved.status !== "reserved") {
          if (holdReservationId !== undefined) {
            // The compensation: admission refused before the provider was called — the
            // `bound_refused` vocabulary's own meaning, on the writer's plain release seam.
            await release(
              holdReservationId,
              `batch admission refused: cell ${cell.provider}/${cell.model}/${cell.capability} ${reserved.reasonCode}`,
            );
          }
          return {
            status: "refused",
            reasonCode: "reserve_refused",
            detail: {
              cell: `${cell.provider}/${cell.model}/${cell.capability}`,
              cellIndex: index,
              reasonCode: reserved.reasonCode,
              detail: reserved.detail,
            },
          };
        }
        holdReservationId = reserved.reservationId;
      }
      const reservationId = holdReservationId as string;

      // 4. The payer the batch's attribution freezes is the one the door RESOLVED — read
      //    back from the grant, never the request's spelling of it.
      const [grant] = await database
        .select({ userId: accessGrants.userId })
        .from(accessGrants)
        .where(eq(accessGrants.grantId, request.grantId))
        .limit(1);
      if (!grant) {
        await release(
          reservationId,
          "batch admission refused: grant_invalid",
        );
        return {
          status: "refused",
          reasonCode: "reserve_refused",
          detail: { reasonCode: "grant_invalid" },
        };
      }

      // 5. The batch and item rows, under the unique submit key, in ONE transaction — a
      //    batch never exists without its items. The loser of a concurrent insert race reads
      //    the winner's row and dispatches nothing.
      const batchId = `${BATCH_ID_PREFIX}${randomBytes(16).toString("hex")}`;
      const itemRows = request.items.map((item, index) => ({
        itemId: `${BATCH_ITEM_ID_PREFIX}${randomBytes(16).toString("hex")}`,
        batchId,
        itemIndex: index,
        customId: item.customId,
        provider: item.model.provider,
        model: item.model.model,
        capability: item.model.capability,
        // The raw SQL wrapper is deliberate: the Bun SQL driver encodes parameters
        // jsonb-first, so a JS *string* param would land as a jsonb string scalar the
        // table's shape CHECK refuses — the object itself arrives as the real object
        // (the same documented trap the async settlement detail writes around).
        quantities: sql`${fullQuantitiesOf(item.quantities)}` as unknown as Record<
          string,
          number
        >,
      }));
      const inserted = await database.transaction(async (tx) => {
        const [batchRow] = await tx
          .insert(batchJobs)
          .values({
            batchId,
            submitIdempotencyKey: request.submitIdempotencyKey,
            grantId: request.grantId,
            payerKind: "personal",
            payerId: grant.userId,
            snapshotVersion: request.snapshotVersion,
            rateVersion: request.rateVersion,
            reservationId,
            maximumCredits: cap.maximumCredits,
            itemCount: request.items.length,
            state: "dispatch_unconfirmed",
          })
          .onConflictDoNothing({
            target: batchJobs.submitIdempotencyKey,
          })
          .returning();
        if (batchRow === undefined) {
          return { batch: undefined, items: [] };
        }
        await tx.insert(batchItems).values(itemRows);
        return {
          batch: batchRow,
          items: itemRows.map((row) => ({
            itemId: row.itemId,
            customId: row.customId,
          })),
        };
      });
      if (inserted.batch === undefined) {
        const [winner] = await database
          .select()
          .from(batchJobs)
          .where(eq(batchJobs.submitIdempotencyKey, request.submitIdempotencyKey))
          .limit(1);
        if (winner) {
          const items = await database
            .select({
              itemId: batchItems.itemId,
              customId: batchItems.customId,
            })
            .from(batchItems)
            .where(eq(batchItems.batchId, winner.batchId))
            .orderBy(batchItems.itemIndex);
          return { status: "submitted", created: false, ...viewOf(winner, items) };
        }
        return {
          status: "refused",
          reasonCode: "reserve_refused",
          detail: { reasonCode: "reservation_conflict" },
        };
      }

      // 6. The dispatch — once, by the creator, under the submit's stable identity. The
      //    hold already exists, so the provider may be called; an answer that arrives names
      //    the provider batch, an answer that does not moves the hold to 06.8's `unknown`
      //    with its FULL cap still occupied — "lost" is never read as "no cost".
      const dispatched = await dispatch({
        batchId,
        reservationId,
        submitIdempotencyKey: request.submitIdempotencyKey,
      });
      if (dispatched.kind === "lost") {
        await markUnknown(reservationId, "batch_dispatch_answer_lost");
      }
      const [final] = await database
        .update(batchJobs)
        .set(
          dispatched.kind === "answered"
            ? {
                providerBatchId: dispatched.providerBatchId,
                state: "submitted",
                dispatchedAt: now(),
              }
            : { state: "dispatch_unconfirmed" },
        )
        .where(eq(batchJobs.batchId, batchId))
        .returning();
      return {
        status: "submitted",
        created: true,
        ...viewOf(final ?? inserted.batch, inserted.items),
      };
    },
  };
}

export type BatchSubmitService = ReturnType<typeof createBatchSubmitService>;
