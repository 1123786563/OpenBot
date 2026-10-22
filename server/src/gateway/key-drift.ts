import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getLogger, type Logger } from "../../../shared/logger";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  GATEWAY_KEY_DRIFT_DECISIONS,
  GATEWAY_KEY_FIELD_DRIFT_REASON_CODES,
  type GatewayKeyDriftDecision,
  type GatewayKeyFieldDriftReasonCode,
  gatewayKeyDriftEvents,
  gatewayVirtualKeys,
} from "../db/schema";

export type { GatewayKeyDriftDecision, GatewayKeyFieldDriftReasonCode };
export { GATEWAY_KEY_DRIFT_DECISIONS, GATEWAY_KEY_FIELD_DRIFT_REASON_CODES };

/*
 * The key FIELD-drift module (Bifrost 05.9, AC11/Q18): what it means for a short-lived
 * virtual key's record at the gateway to stop matching the record OpenBot issued it under,
 * and what OpenBot does about it.
 *
 * THE MINIMAL FIELD SET. Only the three fields OpenBot's own mint wrote are compared —
 * the OWNER (which Customer the key bills), the SCOPE (all providers, no per-provider
 * narrowing) and the TERM (the expiry the mint gave it). Nothing else the management
 * answer carries is drift: a comparison that is too wide pauses grants for cosmetic
 * diffs, and a false pause is exactly the failure mode this module exists to avoid. A new
 * compared field arrives with its own reason code, never a widening of these.
 *
 * DRIFT IS A VERDICT, NOT AN ERASER. A mismatch does not rewrite the key's status — the
 * key may still work at the gateway, and OpenBot's word for it does not change. The
 * verdict is: the mismatch is recorded as one auditable, disposable event per key and
 * reason, and while that event is OUTSTANDING (undisposed) the key's AUTHORIZATION is
 * paused — issuance and renewal for its grant refuse with their own typed reasons until a
 * human disposes of the event. The partial unique index behind the writer makes the
 * one-outstanding-event rule physical: a re-observation does not stack rows, and after a
 * disposition a persisting mismatch re-detects on the next sync — the verdict re-arms
 * against a truth that did not change.
 *
 * MANUAL KEYS ARE NOT ADOPTED. Nothing here, and nothing in the sync that feeds it, ever
 * reads a key OpenBot did not issue: the sync addresses only the ids in
 * `gateway_virtual_keys`, so an operator-created key at the gateway produces no event, no
 * record, no authorization and no account mapping. From a gateway-side key's existence
 * OpenBot derives nothing.
 */

/**
 * How far the remote term may differ from the local one before it is drift, in
 * milliseconds. The value OpenBot sent is stored and answered back through JSON; a
 * tolerance absorbs reformatting (a relay re-rendering precision, a timezone spelling)
 * without letting an actual rewrite — an operator extending or shortening the key's life
 * by minutes — pass as formatting.
 */
export const GATEWAY_KEY_TERM_DRIFT_TOLERANCE_MS = 2_000;

/**
 * The gateway's answer about one key, stripped to the fields this module compares. The
 * sync's {@link GatewayKeyRemoteState} satisfies this shape by construction; stating it
 * here keeps the comparison honest about exactly what it reads.
 */
export type GatewayKeyRemoteAnswer = {
  isActive: boolean;
  /** The expiry the gateway holds for the key, ISO 8601, or null while none was given. */
  expiresAt: string | null;
  /** The customer the gateway says the key bills, or null when it answers to none. */
  customerId: string | null;
  /** Whether the key may call every provider; OpenBot's mint always answers true. */
  allowAllProviders: boolean;
  /** How many per-provider configs narrow the key's deny-by-default surface. */
  providerConfigCount: number;
};

/** The local fields one comparison reads off the key record. */
export type GatewayKeyLocalFields = {
  /** 05.1's mapping id — the one customer this key was minted to bill. */
  gatewayCustomerId: string;
  /** The term the key was minted under (05.5); null on pre-05.5 records. */
  expiresAt: Date | string | null;
};

/** One field mismatch, as the comparison answers it. */
export type GatewayKeyFieldDrift = {
  reasonCode: GatewayKeyFieldDriftReasonCode;
  /** The remote side of an ownership mismatch (null: the key answers to no customer). */
  remoteCustomerId: string | null;
  /** Both sides of a term mismatch, ISO 8601, for the event row and the operator. */
  localExpiresAt: string | null;
  remoteExpiresAt: string | null;
};

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toMs(value: Date | string | null): number | null {
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Compare the minimal field set: the owner the key bills, the scope it answers to, the
 * term it lives under. Answers every mismatch, in the fixed code order — a healthy key
 * answers an empty list, and nothing else the remote answer carries can make it answer
 * anything at all.
 */
export function compareGatewayKeyFields(
  record: GatewayKeyLocalFields,
  remote: GatewayKeyRemoteAnswer,
): GatewayKeyFieldDrift[] {
  const drifts: GatewayKeyFieldDrift[] = [];
  if (remote.customerId !== record.gatewayCustomerId) {
    drifts.push({
      reasonCode: "gateway_key_owner_changed",
      remoteCustomerId: remote.customerId,
      localExpiresAt: toIso(record.expiresAt),
      remoteExpiresAt: remote.expiresAt,
    });
  }
  // The minted scope is "every provider, nothing narrower": a key that lost the
  // all-provider surface, or one an operator pinned to specific providers, no longer
  // accesses what OpenBot authorized.
  if (!remote.allowAllProviders || remote.providerConfigCount > 0) {
    drifts.push({
      reasonCode: "gateway_key_scope_changed",
      remoteCustomerId: remote.customerId,
      localExpiresAt: toIso(record.expiresAt),
      remoteExpiresAt: remote.expiresAt,
    });
  }
  const localMs = toMs(record.expiresAt);
  const remoteMs = toMs(remote.expiresAt);
  const termless = localMs === null && remoteMs === null;
  const sameTerm =
    termless ||
    (localMs !== null &&
      remoteMs !== null &&
      Math.abs(remoteMs - localMs) <= GATEWAY_KEY_TERM_DRIFT_TOLERANCE_MS);
  if (!sameTerm) {
    drifts.push({
      reasonCode: "gateway_key_term_changed",
      remoteCustomerId: remote.customerId,
      localExpiresAt: toIso(record.expiresAt),
      remoteExpiresAt: remote.expiresAt,
    });
  }
  return drifts;
}

/** A `gkde-` event row id: 8 random bytes as hex, the draw size the other gateway ids use. */
function generateDriftEventId(): string {
  return `gkde-${randomBytes(8).toString("hex")}`;
}

/** The insert values one field-drift event lands as — the sync's transaction writes them. */
export function gatewayKeyDriftEventValues(
  event: {
    keyId: string;
    grantId: string;
    botId: string;
    gatewayVirtualKeyId: string;
    localCustomerId: string;
  } & GatewayKeyFieldDrift,
  detectedAt: Date,
) {
  const localExpiresAt = toMs(event.localExpiresAt);
  const remoteExpiresAt = toMs(event.remoteExpiresAt);
  return {
    id: generateDriftEventId(),
    keyId: event.keyId,
    grantId: event.grantId,
    botId: event.botId,
    gatewayVirtualKeyId: event.gatewayVirtualKeyId,
    localCustomerId: event.localCustomerId,
    reasonCode: event.reasonCode,
    remoteCustomerId: event.remoteCustomerId,
    localExpiresAt: localExpiresAt === null ? null : new Date(localExpiresAt),
    remoteExpiresAt:
      remoteExpiresAt === null ? null : new Date(remoteExpiresAt),
    detectedAt,
  };
}

/** One stored drift event, as every reader sees it. */
export type GatewayKeyDriftEventRow = typeof gatewayKeyDriftEvents.$inferSelect;

/**
 * The outstanding (undisposed) drift reasons for one authorization — the pause verdict's
 * whole input. The issuance and renewal seams call this before anything is dialed or
 * minted: a grant with an outstanding event is a grant whose keys' owner, scope or term
 * the gateway no longer agrees to, and no new key extends that disagreement.
 */
export async function outstandingGatewayKeyDriftReasons(
  database: Database,
  grantId: string,
): Promise<GatewayKeyFieldDriftReasonCode[]> {
  const rows = await database
    .select({ reasonCode: gatewayKeyDriftEvents.reasonCode })
    .from(gatewayKeyDriftEvents)
    .where(
      and(
        eq(gatewayKeyDriftEvents.grantId, grantId),
        isNull(gatewayKeyDriftEvents.disposedAt),
      ),
    );
  return [...new Set(rows.map((row) => row.reasonCode))];
}

/**
 * Where the drift events persist and where humans dispose of them. The reads answer the
 * operator surfaces; {@link dispose} is the one writer after detection, guarded so a
 * decision is recorded exactly once — never overwritten, never doubled.
 */
export type GatewayKeyDriftStore = {
  /** The outstanding reasons for one grant (see {@link outstandingGatewayKeyDriftReasons}). */
  outstandingReasonsForGrant(
    grantId: string,
  ): Promise<GatewayKeyFieldDriftReasonCode[]>;
  /** Every outstanding event for one grant, oldest first. */
  listOutstandingForGrant(grantId: string): Promise<GatewayKeyDriftEventRow[]>;
  /** The events an operator surface lists, filtered as asked; oldest first. */
  listEvents(filter?: {
    grantId?: string;
    keyId?: string;
    outstandingOnly?: boolean;
  }): Promise<GatewayKeyDriftEventRow[]>;
  /** One event by id, or undefined. */
  getEvent(eventId: string): Promise<GatewayKeyDriftEventRow | undefined>;
  /**
   * Record one human decision on an outstanding event. `accepted` lifts the pause and
   * leaves the key as it is; `key_revoked` also retires the local key record (guarded on
   * `active`, the same word the sync and revocation keep). Answers whether THIS call made
   * the disposition — an already-disposed event disposes again as `false`, never twice.
   */
  dispose(input: {
    eventId: string;
    decision: GatewayKeyDriftDecision;
    disposedBy: string;
    note?: string;
  }): Promise<{ disposed: boolean; keyRevoked: boolean }>;
};

/** The wall clock, the disposition's default measure. */
function defaultNow(): Date {
  return new Date();
}

export function createGatewayKeyDriftStore(
  database: Database,
  options?: { now?: () => Date; auditStore?: AuditStore; log?: Logger },
): GatewayKeyDriftStore {
  const now = options?.now ?? defaultNow;
  const log = options?.log ?? getLogger("server");

  return {
    outstandingReasonsForGrant: (grantId) =>
      outstandingGatewayKeyDriftReasons(database, grantId),

    async listOutstandingForGrant(grantId) {
      return database
        .select()
        .from(gatewayKeyDriftEvents)
        .where(
          and(
            eq(gatewayKeyDriftEvents.grantId, grantId),
            isNull(gatewayKeyDriftEvents.disposedAt),
          ),
        )
        .orderBy(gatewayKeyDriftEvents.detectedAt);
    },

    async listEvents(filter = {}) {
      const conditions = [];
      if (filter.grantId !== undefined) {
        conditions.push(eq(gatewayKeyDriftEvents.grantId, filter.grantId));
      }
      if (filter.keyId !== undefined) {
        conditions.push(eq(gatewayKeyDriftEvents.keyId, filter.keyId));
      }
      if (filter.outstandingOnly) {
        conditions.push(isNull(gatewayKeyDriftEvents.disposedAt));
      }
      const query = database.select().from(gatewayKeyDriftEvents).$dynamic();
      if (conditions.length > 0) {
        query.where(and(...conditions));
      }
      return query.orderBy(gatewayKeyDriftEvents.detectedAt);
    },

    async getEvent(eventId) {
      const [row] = await database
        .select()
        .from(gatewayKeyDriftEvents)
        .where(eq(gatewayKeyDriftEvents.id, eventId))
        .limit(1);
      return row;
    },

    async dispose({ eventId, decision, disposedBy, note }) {
      // The decision set is closed; a value outside it is a caller bug, refused here
      // rather than stored as an unreadable disposition.
      if (!GATEWAY_KEY_DRIFT_DECISIONS.includes(decision)) {
        throw new Error(
          `The drift disposition decision must be one of ${GATEWAY_KEY_DRIFT_DECISIONS.join(", ")}, got "${String(decision)}".`,
        );
      }
      if (disposedBy.trim() === "") {
        throw new Error(
          "The drift disposition must name who disposed of the event.",
        );
      }
      return database.transaction(async (tx) => {
        // The guarded write: exactly one disposition per event, ever — a second caller
        // races nothing, the WHERE clause answers.
        const [disposedRow] = await tx
          .update(gatewayKeyDriftEvents)
          .set({
            disposition: decision,
            disposedAt: now(),
            disposedBy: disposedBy.trim(),
            ...(note === undefined ? {} : { dispositionNote: note }),
          })
          .where(
            and(
              eq(gatewayKeyDriftEvents.id, eventId),
              isNull(gatewayKeyDriftEvents.disposedAt),
            ),
          )
          .returning({
            keyId: gatewayKeyDriftEvents.keyId,
            grantId: gatewayKeyDriftEvents.grantId,
            reasonCode: gatewayKeyDriftEvents.reasonCode,
          });
        if (disposedRow === undefined) {
          return { disposed: false, keyRevoked: false };
        }
        let keyRevoked = false;
        if (decision === "key_revoked") {
          const [flipped] = await tx
            .update(gatewayVirtualKeys)
            .set({ status: "revoked" })
            .where(
              and(
                eq(gatewayVirtualKeys.id, disposedRow.keyId),
                eq(gatewayVirtualKeys.status, "active"),
              ),
            )
            .returning({ id: gatewayVirtualKeys.id });
          keyRevoked = flipped !== undefined;
        }
        // After the commit, the trail names the human act — who decided, on which event,
        // which decision. Fail-soft like the sync's detection alert: the disposition row
        // itself is the durable record, so a broken trail write is logged, never a
        // rollback of a decision already made.
        if (options?.auditStore) {
          try {
            await recordAuditEvent(options.auditStore, {
              eventType: "gateway.key_drift_disposed",
              targetType: "gateway_key_drift_event",
              targetId: eventId,
              actorUserId: disposedBy.trim(),
              payload: {
                eventId,
                keyId: disposedRow.keyId,
                grantId: disposedRow.grantId,
                reasonCode: disposedRow.reasonCode,
                decision,
                keyRevoked,
                ...(note === undefined ? {} : { note }),
              },
            });
          } catch (error) {
            log.error(
              {
                type: "gateway-key-drift-dispose-audit-failed",
                eventId,
                errorName:
                  error instanceof Error ? error.name : String(typeof error),
              },
              "A key drift disposition could not be written to the audit trail; the disposition row itself is the durable record.",
            );
          }
        }
        return { disposed: true, keyRevoked };
      });
    },
  };
}

/** Serialize one event for the administrator surface — dates as ISO, nothing upstream. */
export function serializeKeyDriftEvent(row: GatewayKeyDriftEventRow) {
  return {
    id: row.id,
    keyId: row.keyId,
    grantId: row.grantId,
    botId: row.botId,
    gatewayVirtualKeyId: row.gatewayVirtualKeyId,
    localCustomerId: row.localCustomerId,
    reasonCode: row.reasonCode,
    remoteCustomerId: row.remoteCustomerId,
    localExpiresAt: row.localExpiresAt?.toISOString() ?? null,
    remoteExpiresAt: row.remoteExpiresAt?.toISOString() ?? null,
    detectedAt: row.detectedAt.toISOString(),
    disposition: row.disposition,
    disposedAt: row.disposedAt?.toISOString() ?? null,
    disposedBy: row.disposedBy,
    dispositionNote: row.dispositionNote,
  };
}
