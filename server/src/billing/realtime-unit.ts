import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  creditReservations,
  realtimeSessions,
  realtimeUnits,
} from "../db/schema/credit-reservations";
import type { Tx } from "./capacity";
import type { PayerRef } from "./payer";
import {
  reserveCreditInTransaction,
  RESERVE_BOUND_EVIDENCE_KINDS,
  type CreditReserveRequest,
  type CreditReserveRefusalReasonCode,
  type ReserveBoundEvidence,
} from "./credit-reserve";

/*
 * The realtime billing unit door (Bifrost 15.2, #315): the place a realtime session's money
 * actually moves — one unit, one independent attempt, one hold, taken BEFORE the unit's work
 * is processed (每个计费单元在处理前都有独立 attemptId 与预留).
 *
 * THE SESSION'S FROZEN IDENTITY IS THE UNIT'S ADMISSION BASIS. A unit never re-resolves
 * anything its session already fixed (15.1: 会话期间身份与账务基准固定不变): the grant, the
 * payer, the model cell and BOTH locked versions are read off the session's identity row and
 * handed to 06.3's transactional reserve unchanged. What the door DOES re-prove, inside the
 * same transaction the unit row rides, is everything the door's own verdicts own — the grant
 * still active, the account still the one the grant resolves to, the cell still open and
 * cataloged, the catalog still fresh — because a mid-session revocation or scope close must
 * stop the NEXT unit, never resurrect a basis the session never had. The refusal codes are
 * the reserve door's own closed set, passed through untouched, plus this door's two
 * session-shape codes (`session_not_found`, `session_not_open`).
 *
 * ONE TRANSACTION, ONE UNIT, ONE ANSWER. The unit insert (pending) and the reserve outcome
 * commit as one fact: a caller can never observe a pending unit, and a refused unit is a
 * RECORDED outcome, not an absent one — the row keeps the door's own reason code with no
 * reservation beside it, which is the durable proof that no provider input could be billed
 * to it (预留失败的单元不进入处理，且不产生供应商计费输入; the forwarding gate is 15.3's own
 * subject, and it reads exactly this row's state).
 *
 * UNITS SHARE THE ACCOUNT ATOMICALLY. Every unit's reserve composes the same transactional
 * door over the same account, so the credit writer's customer lock serializes them: two
 * units of one session can never both spend the same cent, and when the balance covers only
 * one, the second is refused with `insufficient_credits` and holds nothing (同一会话的多个
 * 单元共享同一账户的原子额度).
 *
 * REPLAY CONVERGES. One unit per (session, unitKey), ever — the UNIQUE index is the
 * convergence point: a replayed open of the same key answers the ORIGINAL row and its
 * ORIGINAL outcome (the reserved ids, or the recorded refusal), and the reserve's own
 * idempotency key is the unit id, so even a lost response cannot pay for a second hold of
 * one unit (结算重放不重扣).
 *
 * WHO CALLS THIS. The deployment's realtime relay — the counterpart of the chat path's
 * admission composition — with the processing transition (`markProcessing`) driven from the
 * forwarding path the moment a reserved unit's input actually flows. Settled/unknown are
 * later tickets' states (15.4/06.8); the door owns the machine's first half and the query
 * that restores it.
 */

/** The local unit id's prefix — recognisable on sight, like the session's `rs-`. */
export const REALTIME_UNIT_ID_PREFIX = "ru-";

/** Which side of a session's money a unit covers — the ticket's own closed kind set. */
export const REALTIME_UNIT_KINDS = [
  "input_audio",
  "output_audio",
  "response",
  "duration",
] as const;

export type RealtimeUnitKind = (typeof REALTIME_UNIT_KINDS)[number];

/** The unit state machine the ticket pins: pending → reserved → processing → settled | unknown | refused. */
export const REALTIME_UNIT_STATES = [
  "pending",
  "reserved",
  "processing",
  "settled",
  "unknown",
  "refused",
] as const;

export type RealtimeUnitState = (typeof REALTIME_UNIT_STATES)[number];

/**
 * Why a unit open was refused. The reserve door's own closed set, passed through untouched,
 * plus this door's two session-shape codes. A new member is a contract change.
 */
export type RealtimeUnitRefusalReasonCode =
  | "request_invalid"
  | "session_not_found"
  | "session_not_open"
  | CreditReserveRefusalReasonCode;

/** The unit's contract view — the ticket's RealtimeUnit members, as rows answer them. */
export type RealtimeUnitRecord = {
  unitId: string;
  sessionId: string;
  unitKey: string;
  kind: RealtimeUnitKind;
  boundCents: number;
  state: RealtimeUnitState;
  attemptId: string | null;
  reservationId: string | null;
  refusalReason: string | null;
  createdAt: string;
  stateUpdatedAt: string;
};

/** What a unit open answers: the hold the unit took, or the refusal that names why. */
export type RealtimeUnitOpenOutcome =
  | {
      status: "reserved";
      unit: RealtimeUnitRecord;
      attemptId: string;
      reservationId: string;
      maximumCredits: number;
      /**
       * The locked versions the hold carries — the session's own, echoed by the door on a
       * fresh open; on a replay they are read off the hold itself, null only for a hold the
       * writer never locked.
       */
      snapshotVersion: number | null;
      rateVersion: number | null;
      /** True when this is a replay answer of an already-open unit, not a fresh hold. */
      replay?: boolean;
    }
  | {
      status: "refused";
      /**
       * The refused unit's row — the recorded evidence — or null when the refusal preceded
       * the unit's existence (the shape boundary, a session that does not resolve): those
       * refusals write no row at all, and a null is the honest answer, never a fabricated
       * record.
       */
      unit: RealtimeUnitRecord | null;
      reasonCode: RealtimeUnitRefusalReasonCode;
      detail: Record<string, unknown>;
    };

/** What the processing transition answers: the moved unit, or the state that refused the move. */
export type RealtimeUnitProcessingOutcome =
  | { status: "processing"; unit: RealtimeUnitRecord }
  | { status: "not_moved"; unit: RealtimeUnitRecord };

/** One unit open request's server-verified shape. */
export type RealtimeUnitOpenInput = {
  sessionId: string;
  unitKey: string;
  kind: RealtimeUnitKind;
  boundCents: number;
  boundEvidence: ReserveBoundEvidence[];
  expiresAt?: string | Date;
};

/** The environment the unit door runs in. */
export type RealtimeUnitDependencies = {
  database: Database;
  /** Injectable clock; the app clock by default. */
  now?: () => Date;
  /** 03.6's freshness window, threaded to the reserve door unchanged. */
  catalogFreshnessWindowMs?: number;
};

function refused(
  unit: RealtimeUnitRecord | null,
  reasonCode: RealtimeUnitRefusalReasonCode,
  detail: Record<string, unknown>,
): RealtimeUnitOpenOutcome {
  return { status: "refused", unit, reasonCode, detail };
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
 * Pure shape validation, the protocol doors' own discipline: closed fields, the ticket's own
 * kind set, a positive whole ceiling within the 32-bit column, and bound evidence that is a
 * non-empty set of mechanism proofs with real ceilings — the same shape 06.3's own request
 * validation enforces, checked here because the door composes the transactional core and an
 * estimate-shaped entry proves nothing enforceable.
 */
function validateOpenRequest(
  input: unknown,
): { ok: true; request: RealtimeUnitOpenInput } | { ok: false; detail: Record<string, unknown> } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, detail: { field: "body" } };
  }
  const raw = input as Record<string, unknown>;
  if (!isIdentifier(raw.sessionId, 512)) {
    return { ok: false, detail: { field: "sessionId" } };
  }
  if (!isIdentifier(raw.unitKey, 512)) {
    return { ok: false, detail: { field: "unitKey" } };
  }
  if (!REALTIME_UNIT_KINDS.includes(raw.kind as RealtimeUnitKind)) {
    return { ok: false, detail: { field: "kind" } };
  }
  if (
    !Number.isSafeInteger(raw.boundCents) ||
    (raw.boundCents as number) <= 0 ||
    (raw.boundCents as number) > 2_147_483_647
  ) {
    return { ok: false, detail: { field: "boundCents" } };
  }
  const evidence = raw.boundEvidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, detail: { field: "boundEvidence" } };
  }
  for (const entry of evidence) {
    const candidate = entry as Record<string, unknown> | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !RESERVE_BOUND_EVIDENCE_KINDS.includes(
        candidate.kind as never,
      ) ||
      !Number.isSafeInteger(candidate.maximumTokens) ||
      (candidate.maximumTokens as number) <= 0
    ) {
      return { ok: false, detail: { field: "boundEvidence" } };
    }
  }
  let expiresAt: string | Date | undefined;
  if (raw.expiresAt !== undefined) {
    expiresAt = raw.expiresAt as string | Date;
  }
  if (expiresAt !== undefined) {
    const parsed =
      expiresAt instanceof Date
        ? expiresAt
        : typeof expiresAt === "string"
          ? new Date(expiresAt)
          : null;
    if (parsed === null || Number.isNaN(parsed.getTime())) {
      return { ok: false, detail: { field: "expiresAt" } };
    }
    expiresAt = parsed;
  }
  return {
    ok: true,
    request: {
      sessionId: raw.sessionId,
      unitKey: raw.unitKey,
      kind: raw.kind as RealtimeUnitKind,
      boundCents: raw.boundCents as number,
      boundEvidence: evidence as ReserveBoundEvidence[],
      expiresAt,
    },
  };
}

function recordOf(row: typeof realtimeUnits.$inferSelect): RealtimeUnitRecord {
  return {
    unitId: row.unitId,
    sessionId: row.sessionId,
    unitKey: row.unitKey,
    kind: row.kind,
    boundCents: row.boundCents,
    state: row.state,
    attemptId: row.attemptId,
    reservationId: row.reservationId,
    refusalReason: row.refusalReason,
    createdAt: row.createdAt.toISOString(),
    stateUpdatedAt: row.stateUpdatedAt.toISOString(),
  };
}

/** The replay's answer: the original row's current truth, converged on without a second hold. */
async function replayOutcome(
  tx: Tx,
  row: typeof realtimeUnits.$inferSelect,
): Promise<RealtimeUnitOpenOutcome> {
  const unit = recordOf(row);
  if (row.state === "refused") {
    // The recorded refusal is the answer: the door's own code, the unit's own row.
    return refused(unit, row.refusalReason as RealtimeUnitRefusalReasonCode, {
      replay: true,
    });
  }
  // Every hold-bearing state (reserved, processing, settled, unknown) answers that the
  // original open took its hold; the unit's own state field carries the precise machine
  // position, and the ids are the original ones. The locked versions are read off the hold
  // itself — never fabricated, and null only for a hold the writer never locked.
  const [hold] = await tx
    .select({
      snapshotVersion: creditReservations.snapshotVersion,
      rateVersion: creditReservations.rateVersion,
    })
    .from(creditReservations)
    .where(eq(creditReservations.id, row.reservationId as string))
    .limit(1);
  return {
    status: "reserved",
    unit,
    attemptId: row.attemptId as string,
    reservationId: row.reservationId as string,
    maximumCredits: row.boundCents,
    snapshotVersion: hold?.snapshotVersion ?? null,
    rateVersion: hold?.rateVersion ?? null,
    replay: true,
  };
}

/**
 * The unit door. Order is the contract: shape → the session's frozen identity (it must
 * exist and be open) → replay convergence → one transaction holding the unit insert and the
 * reserve outcome. A refusal at any pre-transaction step writes nothing; the transaction's
 * own refusals write the refused unit row — the recorded evidence — and nothing else.
 */
export function createRealtimeUnitService(dependencies: RealtimeUnitDependencies) {
  const { database } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  return {
    async openUnit(input: unknown): Promise<RealtimeUnitOpenOutcome> {
      const validated = validateOpenRequest(input);
      if (!validated.ok) {
        // A malformed open writes nothing at all — not even a refused row: the shape
        // boundary precedes the unit's existence, the way every door here orders it.
        return refused(null, "request_invalid", validated.detail);
      }
      const request = validated.request;

      return database.transaction(async (tx) => {
        // 1. The session's frozen identity — the unit's admission basis, read once and used
        //    unchanged. A session that does not exist, or is no longer open (15.6's close
        //    writes that state), admits no unit, and the refusal writes no unit row.
        const [session] = await tx
          .select()
          .from(realtimeSessions)
          .where(eq(realtimeSessions.sessionId, request.sessionId))
          .limit(1);
        if (session === undefined) {
          return refused(null, "session_not_found", {
            sessionId: request.sessionId,
          });
        }
        if (session.state !== "open") {
          return refused(null, "session_not_open", {
            sessionId: request.sessionId,
            state: session.state,
          });
        }

        // 2. Replay convergence: one unit per (session, key), ever. The original row answers
        //    for the replay — no second hold, no second refusal, no state change.
        const [existing] = await tx
          .select()
          .from(realtimeUnits)
          .where(
            and(
              eq(realtimeUnits.sessionId, request.sessionId),
              eq(realtimeUnits.unitKey, request.unitKey),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          return replayOutcome(tx as Tx, existing);
        }

        // 3. The unit row is born pending INSIDE the transaction that immediately answers
        //    it: no caller can observe a pending unit, and the insert and the reserve
        //    outcome commit as one fact.
        const unitId = `${REALTIME_UNIT_ID_PREFIX}${randomBytes(16).toString("hex")}`;
        await tx.insert(realtimeUnits).values({
          unitId,
          sessionId: request.sessionId,
          unitKey: request.unitKey,
          kind: request.kind,
          boundCents: request.boundCents,
          state: "pending",
        });

        // 4. The reserve itself — 06.3's transactional core, composed over THIS transaction
        //    with the session's frozen identity and the unit's own stable id as the
        //    idempotency key: every door verdict (grant, payer, reach, freshness, basis,
        //    evidence, balance, conflict) runs on this connection, and the hold lands or
        //    does not as part of this unit's commit.
        const reserveRequest: CreditReserveRequest = {
          grantId: session.grantId,
          payer: {
            kind: session.payerKind as PayerRef["kind"],
            id: session.payerId,
          },
          model: {
            provider: session.provider,
            model: session.model,
            capability: "realtime",
          },
          snapshotVersion: session.snapshotVersion,
          rateVersion: session.rateVersion,
          boundEvidence: request.boundEvidence,
          maximumCredits: request.boundCents,
          idempotencyKey: unitId,
          expiresAt: request.expiresAt,
        };
        const outcome = await reserveCreditInTransaction(tx as Tx, reserveRequest, {
          now,
          ...(dependencies.catalogFreshnessWindowMs === undefined
            ? {}
            : { catalogFreshnessWindowMs: dependencies.catalogFreshnessWindowMs }),
        });

        if (outcome.status === "refused") {
          // The refused unit is a RECORDED outcome: the door's own code on the row, no
          // reservation beside it — the durable proof no provider input can be billed to
          // this unit. The transaction's refusal wrote no hold; the row keeps the reason.
          const [refusedRow] = await tx
            .update(realtimeUnits)
            .set({
              state: "refused",
              refusalReason: outcome.reasonCode,
              stateUpdatedAt: now(),
            })
            .where(eq(realtimeUnits.unitId, unitId))
            .returning();
          return refused(recordOf(refusedRow), outcome.reasonCode, outcome.detail);
        }

        const [reservedRow] = await tx
          .update(realtimeUnits)
          .set({
            state: "reserved",
            attemptId: outcome.attemptId,
            reservationId: outcome.reservationId,
            stateUpdatedAt: now(),
          })
          .where(eq(realtimeUnits.unitId, unitId))
          .returning();
        return {
          status: "reserved" as const,
          unit: recordOf(reservedRow),
          attemptId: outcome.attemptId,
          reservationId: outcome.reservationId,
          maximumCredits: outcome.maximumCredits,
          snapshotVersion: outcome.snapshotVersion,
          rateVersion: outcome.rateVersion,
        };
      });
    },

    /**
     * The processing transition: reserved → processing, guarded by the state itself — a
     * unit that is not exactly `reserved` does not move, and the answer names the state
     * that refused the move. The update is a single guarded statement, so two racers
     * cannot both move the same unit.
     */
    async markProcessing(
      unitId: string,
    ): Promise<RealtimeUnitProcessingOutcome | undefined> {
      const [row] = await database
        .update(realtimeUnits)
        .set({ state: "processing", stateUpdatedAt: now() })
        .where(
          and(
            eq(realtimeUnits.unitId, unitId),
            eq(realtimeUnits.state, "reserved"),
          ),
        )
        .returning();
      if (row !== undefined) {
        return { status: "processing", unit: recordOf(row) };
      }
      const [current] = await database
        .select()
        .from(realtimeUnits)
        .where(eq(realtimeUnits.unitId, unitId))
        .limit(1);
      return current === undefined
        ? undefined
        : { status: "not_moved", unit: recordOf(current) };
    },

    /** One unit's state — the query the recovery and the forwarding gate read (AC4). */
    async unitState(unitId: string): Promise<RealtimeUnitRecord | undefined> {
      const [row] = await database
        .select()
        .from(realtimeUnits)
        .where(eq(realtimeUnits.unitId, unitId))
        .limit(1);
      return row === undefined ? undefined : recordOf(row);
    },

    /** A session's units, oldest first — the restore read a restarted relay replays. */
    async listUnits(sessionId: string): Promise<RealtimeUnitRecord[]> {
      const rows = await database
        .select()
        .from(realtimeUnits)
        .where(eq(realtimeUnits.sessionId, sessionId))
        .orderBy(asc(realtimeUnits.createdAt));
      return rows.map(recordOf);
    },
  };
}

export type RealtimeUnitService = ReturnType<typeof createRealtimeUnitService>;
