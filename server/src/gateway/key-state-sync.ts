import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getLogger, type Logger } from "../../../shared/logger";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import {
  gatewayKeyDriftEvents,
  gatewayKeySyncDrift,
  gatewayKeySyncState,
  gatewayVirtualKeys,
} from "../db/schema";
import {
  compareGatewayKeyFields,
  gatewayKeyDriftEventValues,
  type GatewayKeyFieldDrift,
} from "./key-drift";

/*
 * The key state sync (Bifrost 05.8, AC11/design Q18): what the gateway does to a short-lived
 * virtual key behind OpenBot's back — an operator deletes it, disables it, its expiry passes —
 * this deployment learns at the next sync, and the key is unavailable HERE from that moment.
 *
 * ONE DIRECTION ONLY: GATEWAY → LOCAL, TOWARD UNAVAILABILITY. Q18 makes OpenBot the authority
 * over authorizations and key lifecycle, so the sync is a reader, never a writer of truths it
 * was not told: it compares each locally `active` key record with the gateway's own answer and
 * can only move a key toward unavailability — deleted (`gateway_key_deleted`) or disabled
 * (`gateway_key_disabled`) become `revoked`, an expired remote expiry becomes `expired`. It
 * never moves a key back toward `active` (a locally revoked or expired key stays so even when
 * the gateway reports the key healthy — OpenBot's own lifecycle decisions are not the gateway's
 * to reverse), and it never imports a remote key OpenBot did not issue: from a gateway state
 * change NO authorization, NO credit grant, NO ledger row and NO key record is derived.
 *
 * 05.9 RIDES THE SAME READ. The per-key answer carries the key's owner, scope and term — the
 * three fields OpenBot's own mint wrote — and a mismatch on any of them is FIELD drift, the
 * drift that is not unavailability: a key moved to another Customer still works, it just
 * bills someone else. Field drift flips nothing (a verdict is not an eraser); each new
 * mismatch lands as one outstanding event in `gateway_key_drift_events`, written in the SAME
 * transaction as the availability flips, and an outstanding event pauses its grant's
 * issuance and renewal until a human disposes of it (see `key-drift.ts`). A key OpenBot did
 * not issue is still invisible here: this run addresses only the ids in `gateway_virtual_keys`.
 *
 * THE REMOTE READ IS PER KEY, ON PURPOSE. The consumed contract is the gateway's own key query
 * (`GET /api/governance/virtual-keys/{vk_id}`): a 404 is a deletion — the strongest signal a
 * list-with-pagination can only approximate, because a missed page there would read as mass
 * deletion. Short-lived keys are few and short-lived; one precise read each is the honest price.
 *
 * LAST-GOOD IS KEPT BY CONSTRUCTION. The remote reads happen FIRST, in full; any refused read
 * aborts the run before a single local row is touched. The flips (and their drift-list rows)
 * then land in ONE transaction — all or nothing — so an apply failure leaves every status
 * exactly as the last good sync left it. Only after a run that read everything and flipped
 * everything does `last_successful_sync_at` move; every failure counts and records a fixed,
 * displayable `gateway_key_sync_*` reason in the singleton state row.
 *
 * ONE SYNC AT A TIME. Concurrent `runSync()` calls — the timer firing while the on-demand
 * trigger (the installed instance the same 03.5-style administrator surface calls) clicks —
 * share the one in-flight run and its one outcome. The deployment wiring starts the scheduler
 * (`startGatewayKeyStateSyncScheduler`); the cadence is configuration
 * (`BIFROST_KEY_STATE_SYNC_INTERVAL_MS`), never a constant in a timer.
 */

/**
 * The cadence this sync runs on by default: one sync a minute. A short-lived key's whole life
 * is minutes (Q13's default fifteen), so "immediately unavailable" is a minute-scale promise;
 * a deployment that wants tighter tightens the variable, it does not fork the module.
 */
export const DEFAULT_KEY_STATE_SYNC_INTERVAL_MS = 60_000;

/** The variable a deployment sets to change the cadence; validated, never guessed. */
export const BIFROST_KEY_STATE_SYNC_INTERVAL_MS_VARIABLE =
  "BIFROST_KEY_STATE_SYNC_INTERVAL_MS";

/**
 * Read the sync interval from the deployment environment, or answer the default. A
 * set-but-invalid value stops the caller (the deployment wiring, at boot) with the variable
 * named — a silent fallback would have a deployment running the cadence it refused.
 */
export function gatewayKeyStateSyncIntervalConfig(
  environment: Record<string, string | undefined>,
): number {
  const raw = environment[BIFROST_KEY_STATE_SYNC_INTERVAL_MS_VARIABLE]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_KEY_STATE_SYNC_INTERVAL_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(
      `${BIFROST_KEY_STATE_SYNC_INTERVAL_MS_VARIABLE} must be a positive whole number of milliseconds, got "${raw}".`,
    );
  }
  return value;
}

/**
 * Why a remote read refused. Fixed constants of this module, displayable anywhere, none built
 * from upstream data — the same discipline the issuance adapter's reason codes keep.
 */
export type GatewayKeySyncFailureReasonCode =
  | "gateway_key_sync_endpoint_not_configured"
  | "gateway_key_sync_credential_unavailable"
  | "gateway_key_sync_unreachable"
  | "gateway_key_sync_timeout"
  | "gateway_key_sync_unauthenticated"
  | "gateway_key_sync_invalid_response"
  | "gateway_key_sync_unexpected_status"
  | "gateway_key_sync_unexpected_error"
  | "gateway_key_sync_apply_failed";

export class GatewayKeyStateError extends Error {
  readonly reasonCode: GatewayKeySyncFailureReasonCode;

  constructor(
    reasonCode: GatewayKeySyncFailureReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayKeyStateError";
    this.reasonCode = reasonCode;
  }
}

/**
 * What the gateway answered about one key, stripped to what a status — and, since 05.9, a
 * field comparison — needs.
 */
export type GatewayKeyRemoteState = {
  /**
   * The gateway's own availability switch. The management surface carries it as a Go `*bool`
   * (`is_active`) where absent means true; the adapter folds that here before anything reads it.
   */
  isActive: boolean;
  /** The expiry the gateway holds for the key, ISO 8601, or null while none was given. */
  expiresAt: string | null;
  /** The customer the gateway says the key bills, or null when it answers to no customer —
   * 05.9 compares this against the record's own owner. */
  customerId: string | null;
  /** Whether the key may call every provider; OpenBot's mint always answers true (05.9). */
  allowAllProviders: boolean;
  /** How many per-provider configs narrow the key's deny-by-default surface (05.9). */
  providerConfigCount: number;
};

/** The answer to one remote key read: its state, or the deletion the 404 speaks. */
export type GatewayKeyStateQuery =
  | { found: true; state: GatewayKeyRemoteState }
  | { found: false };

/**
 * The transport seam the sync reads key states through. Every transport failure is one of the
 * typed {@link GatewayKeyStateError} reason codes, never a bare throw the caller must parse;
 * a key the gateway no longer holds is an ANSWER (`found: false`), not an error.
 */
export type GatewayKeyStateClient = {
  getVirtualKeyState: (input: {
    gatewayVirtualKeyId: string;
  }) => Promise<GatewayKeyStateQuery>;
};

/** The local record of one key, as the sync reads it. */
export type GatewayKeyRecordRow = {
  keyId: string;
  grantId: string;
  botId: string;
  gatewayVirtualKeyId: string;
  /** The owner the record believes this key bills — the comparison's local side (05.9). */
  gatewayCustomerId: string;
  /** The term the record carries — the comparison's local side (05.9). */
  expiresAt: Date | null;
  status: (typeof gatewayVirtualKeys.$inferSelect)["status"];
};

/** Why a sync flipped a key — the fixed observation codes, one per gateway-side cause. */
export type KeyDriftReasonCode =
  | "gateway_key_deleted"
  | "gateway_key_disabled"
  | "gateway_key_expired";

/** One flipped key, as the run's answer and the drift list carry it. */
export type KeyDriftRecord = {
  /** The local key record that flipped (`gateway_virtual_keys.id`). */
  keyId: string;
  grantId: string;
  botId: string;
  gatewayVirtualKeyId: string;
  /** Always `active` — the sync only ever moves an active key, toward unavailability. */
  from: "active";
  to: "revoked" | "expired";
  reasonCode: KeyDriftReasonCode;
};

/**
 * One FIELD mismatch (05.9): the record and the gateway disagree on the owner, the scope
 * or the term. Unlike a {@link KeyDriftRecord} this flips no status — it is recorded as
 * one outstanding event per key and reason (the one-outstanding rule is the partial
 * unique index), and the event pauses its grant's issuance and renewal until disposed.
 */
export type KeyFieldDriftRecord = {
  keyId: string;
  grantId: string;
  botId: string;
  gatewayVirtualKeyId: string;
  localCustomerId: string;
} & GatewayKeyFieldDrift;

/** The sync state's fixed singleton id — one state row per deployment. */
export const GATEWAY_KEY_SYNC_STATE_ID = "gateway_key_sync";

/** The state as of now; the never-synced answer before the first attempt. */
export type GatewayKeySyncStateRow = {
  /** When the last fully successful sync completed; null before the first one. */
  lastSuccessfulSyncAt: string | null;
  /** Failures in a row since the last success; zeroed by the next success. */
  consecutiveFailures: number;
  /** The last failure's fixed reason code; present exactly when the last attempt failed. */
  lastFailureReasonCode: GatewayKeySyncFailureReasonCode | null;
  /** When the last failure was classified. */
  lastFailureAt: string | null;
  /** When the last attempt of either outcome completed. */
  lastAttemptAt: string | null;
  /** The last attempt's outcome. */
  lastAttemptStatus: "ok" | "failed" | null;
};

const NEVER_SYNCED: GatewayKeySyncStateRow = {
  lastSuccessfulSyncAt: null,
  consecutiveFailures: 0,
  lastFailureReasonCode: null,
  lastFailureAt: null,
  lastAttemptAt: null,
  lastAttemptStatus: null,
};

/**
 * Where the sync state persists. Transitions are single atomic statements — an upsert whose
 * DO UPDATE computes the failure count from the row itself, so two syncs racing the singleton
 * cannot lose an increment and no read-modify-write window exists.
 */
export type GatewayKeySyncStateStore = {
  /** The state as of now; the never-synced answer before the first attempt. */
  readSyncState(): Promise<GatewayKeySyncStateRow>;
  /** Record a fully successful sync: success time moves, failures zero, reason clears. */
  recordSyncSuccess(args: { syncedAt: string }): Promise<void>;
  /** Record a failed attempt: the count increments atomically, the reason lands. */
  recordSyncFailure(args: {
    reasonCode: GatewayKeySyncFailureReasonCode;
    failedAt: string;
  }): Promise<void>;
};

/** Read one stored row into the shape the module answers; absent means never synced. */
function syncStateFromRow(row: {
  lastSuccessfulSyncAt: Date | null;
  consecutiveFailures: number;
  lastFailureReasonCode: string | null;
  lastFailureAt: Date | null;
  lastAttemptAt: Date | null;
  lastAttemptStatus: string | null;
}): GatewayKeySyncStateRow {
  const lastAttemptStatus =
    row.lastAttemptStatus === "ok" || row.lastAttemptStatus === "failed"
      ? row.lastAttemptStatus
      : null;
  return {
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    // The reason code is stored as written and read back as the union — the column carries no
    // enum CHECK of its own, so this cast is the reader trusting the writer: only this module's
    // fixed codes are ever recorded, and nothing here invents a reason for one it does not know.
    lastFailureReasonCode:
      row.lastFailureReasonCode as GatewayKeySyncFailureReasonCode | null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastAttemptStatus,
  };
}

/** The sync state store over the singleton table — the sibling of the catalog sync's store. */
export function createGatewayKeyStateStore(
  database: Database,
): GatewayKeySyncStateStore {
  return {
    async readSyncState() {
      const [row] = await database
        .select({
          lastSuccessfulSyncAt: gatewayKeySyncState.lastSuccessfulSyncAt,
          consecutiveFailures: gatewayKeySyncState.consecutiveFailures,
          lastFailureReasonCode: gatewayKeySyncState.lastFailureReasonCode,
          lastFailureAt: gatewayKeySyncState.lastFailureAt,
          lastAttemptAt: gatewayKeySyncState.lastAttemptAt,
          lastAttemptStatus: gatewayKeySyncState.lastAttemptStatus,
        })
        .from(gatewayKeySyncState)
        .where(eq(gatewayKeySyncState.id, GATEWAY_KEY_SYNC_STATE_ID))
        .limit(1);
      return row === undefined ? NEVER_SYNCED : syncStateFromRow(row);
    },

    async recordSyncSuccess({ syncedAt }) {
      await database
        .insert(gatewayKeySyncState)
        .values({
          id: GATEWAY_KEY_SYNC_STATE_ID,
          lastSuccessfulSyncAt: new Date(syncedAt),
          consecutiveFailures: 0,
          lastAttemptAt: new Date(syncedAt),
          lastAttemptStatus: "ok",
        })
        .onConflictDoUpdate({
          target: gatewayKeySyncState.id,
          set: {
            // Only this statement writes the success column: a failure that lands after it
            // cannot move the success time backwards.
            lastSuccessfulSyncAt: new Date(syncedAt),
            consecutiveFailures: 0,
            lastFailureReasonCode: null,
            lastFailureAt: null,
            lastAttemptAt: new Date(syncedAt),
            lastAttemptStatus: "ok",
            updatedAt: new Date(),
          },
        });
    },

    async recordSyncFailure({ reasonCode, failedAt }) {
      await database
        .insert(gatewayKeySyncState)
        .values({
          id: GATEWAY_KEY_SYNC_STATE_ID,
          consecutiveFailures: 1,
          lastFailureReasonCode: reasonCode,
          lastFailureAt: new Date(failedAt),
          lastAttemptAt: new Date(failedAt),
          lastAttemptStatus: "failed",
        })
        .onConflictDoUpdate({
          target: gatewayKeySyncState.id,
          set: {
            // The count is computed from the row itself, so two syncs racing the singleton
            // serialize on the row lock and neither loses one.
            consecutiveFailures: sql`${gatewayKeySyncState.consecutiveFailures} + 1`,
            lastFailureReasonCode: reasonCode,
            lastFailureAt: new Date(failedAt),
            lastAttemptAt: new Date(failedAt),
            lastAttemptStatus: "failed",
            updatedAt: new Date(),
          },
        });
    },
  };
}

/** What {@link GatewayKeyStateSyncService.runSync} answers — never a throw. */
export type KeyStateSyncOutcome =
  | {
      status: "ok";
      /** How many locally active keys were checked against the gateway. */
      checked: number;
      /** The keys this run flipped toward unavailability, with the why of each. */
      drifted: KeyDriftRecord[];
      /** The field mismatches this run RECORDED as new outstanding events (05.9) —
       * re-observations of an already-outstanding mismatch do not reappear here. */
      driftEvents: KeyFieldDriftRecord[];
      /** When the sync completed, ISO 8601 — the moment the state row records. */
      syncedAt: string;
    }
  | {
      status: "failed";
      /** `fetch`: a remote read refused before anything was touched. `apply`: the one
       * transaction rolled back — the last-good statuses survived it by construction. */
      stage: "fetch" | "apply";
      /** The fixed, displayable reason code. */
      reasonCode: GatewayKeySyncFailureReasonCode;
      /** When the failure was classified, ISO 8601. */
      failedAt: string;
    };

/** What a status surface reads: in-flight plus the persisted state. */
export type GatewayKeySyncStatus = {
  /** Whether a sync is running in this process right now. */
  inFlight: boolean;
  /** The persisted state between runs — success time, failure count, reason. */
  state: GatewayKeySyncStateRow;
};

/**
 * The one observation a remote answer can produce, folded against the local record.
 * Availability drift only — field drift is {@link fieldDriftsFor}'s, and the two verdicts
 * are independent answers to the same read.
 */
function driftFor(
  record: GatewayKeyRecordRow,
  query: GatewayKeyStateQuery,
  now: Date,
): KeyDriftRecord | undefined {
  const identity = {
    keyId: record.keyId,
    grantId: record.grantId,
    botId: record.botId,
    gatewayVirtualKeyId: record.gatewayVirtualKeyId,
    from: "active",
  } as const;
  // Deleted: the gateway answers no key for the id any more. Disabled: it holds the key but
  // answered `is_active: false`. Both are the same local truth — the key cannot be used.
  if (!query.found) {
    return { ...identity, to: "revoked", reasonCode: "gateway_key_deleted" };
  }
  if (!query.state.isActive) {
    return { ...identity, to: "revoked", reasonCode: "gateway_key_disabled" };
  }
  // Expired: the gateway holds an expiry and it has passed. The local word is the local
  // vocabulary's own expiry state — the same "cannot be used", named for its cause.
  if (
    query.state.expiresAt !== null &&
    Date.parse(query.state.expiresAt) <= now.getTime()
  ) {
    return { ...identity, to: "expired", reasonCode: "gateway_key_expired" };
  }
  // Healthy at the gateway: nothing to do — and never the reverse direction. A local
  // revoked/expired row is not even read here (the sync only selects active rows), so
  // OpenBot's own lifecycle decisions cannot be undone by a gateway that disagrees.
  return undefined;
}

/**
 * The 05.9 half of the same read: the minimal field set (owner, scope, term) compared
 * against the record. Nothing here flips a status — an event the disposition can accept is
 * a different verdict from unavailability, and confusing the two would let a mismatch
 * masquerade as a death (or a death as a disagreement).
 */
function fieldDriftsFor(
  record: GatewayKeyRecordRow,
  state: GatewayKeyRemoteState,
): KeyFieldDriftRecord[] {
  return compareGatewayKeyFields(record, state).map((field) => ({
    keyId: record.keyId,
    grantId: record.grantId,
    botId: record.botId,
    gatewayVirtualKeyId: record.gatewayVirtualKeyId,
    localCustomerId: record.gatewayCustomerId,
    ...field,
  }));
}

/** A `gksd-` drift row id: 8 random bytes as hex, the draw size the other gateway ids use. */
function generateDriftId(): string {
  return `gksd-${randomBytes(8).toString("hex")}`;
}

export type GatewayKeyStateSyncDeps = {
  database: Database;
  /** The remote read seam (see {@link GatewayKeyStateClient}). */
  client: GatewayKeyStateClient;
  store: GatewayKeySyncStateStore;
  /** The append-only trail every NEW field-drift event is written to (05.9); optional in
   * the type, wired by every deployment composition — a drift the trail cannot name still
   * lands in the drift table, but the alerting reads the trail. */
  auditStore?: AuditStore;
  /** Injectable clock for tests. */
  now?: () => Date;
  log?: Logger;
};

export type GatewayKeyStateSyncService = {
  /**
   * Run one sync now: read every locally active key, read its remote state, flip what died,
   * record what drifted, record the state. Concurrent callers join the run already in
   * flight and share its outcome. A failed run keeps the last-good statuses and the last
   * success time, counts the failure, and records the reason; a run that decides anything
   * writes the flips AND their drift rows AND the new field-drift events in one
   * transaction, and creates nothing else — no authorization, no credit, no key.
   */
  runSync: () => Promise<KeyStateSyncOutcome>;
  /** The status a surface displays: in-flight plus the persisted state. */
  readSyncStatus: () => Promise<GatewayKeySyncStatus>;
};

export function createGatewayKeyStateSyncService(
  deps: GatewayKeyStateSyncDeps,
): GatewayKeyStateSyncService {
  const log = deps.log ?? getLogger("server");
  const now = deps.now ?? (() => new Date());
  // The single-flight cell: the in-flight run's promise while one runs, undefined otherwise.
  // Concurrent callers await the same promise and share the same settled outcome object.
  let inFlight: Promise<KeyStateSyncOutcome> | undefined;

  async function runOnce(): Promise<KeyStateSyncOutcome> {
    // 1. The local side of the comparison: only what this deployment currently believes
    // active. This selection IS the no-resurrection rule — a revoked or expired record is
    // invisible to the sync, so no remote answer can reach it. The owner and term ride
    // along as 05.9's comparison sides.
    const activeKeys: GatewayKeyRecordRow[] = await deps.database
      .select({
        keyId: gatewayVirtualKeys.id,
        grantId: gatewayVirtualKeys.grantId,
        botId: gatewayVirtualKeys.botId,
        gatewayVirtualKeyId: gatewayVirtualKeys.gatewayVirtualKeyId,
        gatewayCustomerId: gatewayVirtualKeys.gatewayCustomerId,
        expiresAt: gatewayVirtualKeys.expiresAt,
        status: gatewayVirtualKeys.status,
      })
      .from(gatewayVirtualKeys)
      .where(eq(gatewayVirtualKeys.status, "active"));

    // 2. The remote reads, ALL of them, before a single local row is touched. The first
    // refused read aborts the run: a partial read must never look like a full one, or the
    // keys behind the missed reads would be flipped by an absence that proved nothing.
    // Each answer folds into both verdicts: availability (driftFor) and fields (05.9).
    const drifts: KeyDriftRecord[] = [];
    const fieldDrifts: KeyFieldDriftRecord[] = [];
    for (const record of activeKeys) {
      let query: GatewayKeyStateQuery;
      try {
        query = await deps.client.getVirtualKeyState({
          gatewayVirtualKeyId: record.gatewayVirtualKeyId,
        });
      } catch (error) {
        const reasonCode =
          error instanceof GatewayKeyStateError
            ? error.reasonCode
            : "gateway_key_sync_unexpected_error";
        return recordFailure("fetch", reasonCode);
      }
      const drift = driftFor(record, query, now());
      if (drift !== undefined) drifts.push(drift);
      // A deleted key carries no fields to compare; a found one is compared even when
      // disabled — a moved owner on a disabled key is still a moved owner.
      if (query.found) {
        fieldDrifts.push(...fieldDriftsFor(record, query.state));
      }
    }

    // 3. The verdicts, in ONE transaction: the record of a change and the change itself
    // land together or not at all. Each flip is guarded on the status it was decided
    // against, so a lifecycle writer that moved the row mid-run wins and the sync's stale
    // flip becomes the no-op it deserves to be. Field-drift events land through the same
    // door: the partial unique index keeps one outstanding event per key and reason, so a
    // re-observation is a no-op and `.returning()` answers only the NEWLY recorded ones —
    // exactly the events the alert and audit below name. Nothing else is written — no
    // insert reaches any other table here, which is the zero-creation invariant by
    // construction.
    let newDriftEvents: KeyFieldDriftRecord[] = [];
    if (drifts.length > 0 || fieldDrifts.length > 0) {
      try {
        await deps.database.transaction(async (tx) => {
          for (const drift of drifts) {
            await tx
              .update(gatewayVirtualKeys)
              .set({ status: drift.to })
              .where(
                and(
                  eq(gatewayVirtualKeys.id, drift.keyId),
                  eq(gatewayVirtualKeys.status, drift.from),
                ),
              );
          }
          if (drifts.length > 0) {
            await tx.insert(gatewayKeySyncDrift).values(
              drifts.map((drift) => ({
                id: generateDriftId(),
                keyId: drift.keyId,
                grantId: drift.grantId,
                botId: drift.botId,
                gatewayVirtualKeyId: drift.gatewayVirtualKeyId,
                fromStatus: drift.from,
                toStatus: drift.to,
                reasonCode: drift.reasonCode,
                driftedAt: now(),
              })),
            );
          }
          if (fieldDrifts.length > 0) {
            const detectedAt = now();
            const inserted = await tx
              .insert(gatewayKeyDriftEvents)
              .values(
                fieldDrifts.map((field) =>
                  gatewayKeyDriftEventValues(field, detectedAt),
                ),
              )
              .onConflictDoNothing()
              .returning({
                keyId: gatewayKeyDriftEvents.keyId,
                grantId: gatewayKeyDriftEvents.grantId,
                botId: gatewayKeyDriftEvents.botId,
                gatewayVirtualKeyId:
                  gatewayKeyDriftEvents.gatewayVirtualKeyId,
                localCustomerId: gatewayKeyDriftEvents.localCustomerId,
                reasonCode: gatewayKeyDriftEvents.reasonCode,
                remoteCustomerId: gatewayKeyDriftEvents.remoteCustomerId,
                localExpiresAt: gatewayKeyDriftEvents.localExpiresAt,
                remoteExpiresAt: gatewayKeyDriftEvents.remoteExpiresAt,
              });
            newDriftEvents = inserted.map((row) => ({
              keyId: row.keyId,
              grantId: row.grantId,
              botId: row.botId,
              gatewayVirtualKeyId: row.gatewayVirtualKeyId,
              localCustomerId: row.localCustomerId,
              reasonCode: row.reasonCode,
              remoteCustomerId: row.remoteCustomerId,
              localExpiresAt: row.localExpiresAt?.toISOString() ?? null,
              remoteExpiresAt: row.remoteExpiresAt?.toISOString() ?? null,
            }));
          }
        });
      } catch (error) {
        // The transaction rolled back: every status is still the last-good one and no
        // event was recorded. Record the failure like any other and answer it — the next
        // run re-reads and re-decides.
        log.error(
          {
            type: "gateway-key-sync-apply-failed",
            driftCount: drifts.length,
            fieldDriftCount: fieldDrifts.length,
            errorName: error instanceof Error ? error.name : String(typeof error),
          },
          "The key state verdicts could not be applied; the last-good statuses are kept.",
        );
        return recordFailure("apply", "gateway_key_sync_apply_failed");
      }
    }

    // 4. The state row: only a run that read everything (and applied everything it decided)
    // moves the success time — "last good" here means the statuses this deployment answers
    // with were proven against the gateway, together, or the label is a lie a consumer trusts.
    const syncedAt = now().toISOString();
    try {
      await deps.store.recordSyncSuccess({ syncedAt });
    } catch (error) {
      log.error(
        {
          type: "gateway-key-sync-state-persist-failed",
          errorName: error instanceof Error ? error.name : String(typeof error),
        },
        "The sync succeeded but its state could not be recorded; the next sync will retry the write.",
      );
    }
    if (drifts.length > 0) {
      log.info(
        {
          type: "gateway-key-sync-drift",
          checked: activeKeys.length,
          drifted: drifts.length,
          reasons: Object.entries(
            Object.groupBy(drifts, (drift) => drift.reasonCode),
          ).map(([reasonCode, entries]) => ({
            reasonCode,
            count: entries?.length ?? 0,
          })),
        },
        "The key state sync flipped keys toward unavailability.",
      );
    }

    // 4b. The 05.9 alert: every NEWLY recorded field-drift event is warned once — the
    // alert a deployment's monitoring reads — and written to the audit trail, fail-soft:
    // the drift row itself is the durable record (the transaction above committed it), so
    // a broken trail write must not unmake a verdict already in force. The next sync
    // re-observes and the outstanding event still pauses the grant either way.
    if (newDriftEvents.length > 0) {
      log.warn(
        {
          type: "gateway-key-drift-detected",
          checked: activeKeys.length,
          events: Object.entries(
            Object.groupBy(newDriftEvents, (event) => event.reasonCode),
          ).map(([reasonCode, entries]) => ({
            reasonCode,
            count: entries?.length ?? 0,
          })),
        },
        "The key state sync recorded field drift; the affected authorizations are paused for issuance and renewal until the events are disposed of.",
      );
      if (deps.auditStore) {
        for (const event of newDriftEvents) {
          try {
            await recordAuditEvent(deps.auditStore, {
              eventType: "gateway.key_drift_detected",
              targetType: "gateway_virtual_key",
              targetId: event.keyId,
              payload: {
                grantId: event.grantId,
                botId: event.botId,
                gatewayVirtualKeyId: event.gatewayVirtualKeyId,
                reasonCode: event.reasonCode,
                localCustomerId: event.localCustomerId,
                remoteCustomerId: event.remoteCustomerId,
                localExpiresAt: event.localExpiresAt,
                remoteExpiresAt: event.remoteExpiresAt,
              },
            });
          } catch (error) {
            log.error(
              {
                type: "gateway-key-drift-audit-failed",
                keyId: event.keyId,
                reasonCode: event.reasonCode,
                errorName:
                  error instanceof Error ? error.name : String(typeof error),
              },
              "A recorded key drift event could not be written to the audit trail; the drift row itself is the durable record.",
            );
          }
        }
      }
    }
    return {
      status: "ok",
      checked: activeKeys.length,
      drifted: drifts,
      driftEvents: newDriftEvents,
      syncedAt,
    };
  }

  async function recordFailure(
    stage: "fetch" | "apply",
    reasonCode: GatewayKeySyncFailureReasonCode,
  ): Promise<KeyStateSyncOutcome> {
    const failedAt = now().toISOString();
    try {
      await deps.store.recordSyncFailure({ reasonCode, failedAt });
    } catch (error) {
      // The outcome is already in hand; a broken state row must not unmake it (the probe's
      // persist rule). The count repairs at the next attempt.
      log.error(
        {
          type: "gateway-key-sync-failure-persist-failed",
          reasonCode,
          errorName: error instanceof Error ? error.name : String(typeof error),
        },
        "The sync failure could not be recorded in the state row.",
      );
    }
    return { status: "failed", stage, reasonCode, failedAt };
  }

  return {
    runSync() {
      if (inFlight !== undefined) {
        return inFlight;
      }
      inFlight = runOnce().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    async readSyncStatus() {
      return {
        inFlight: inFlight !== undefined,
        state: await deps.store.readSyncState(),
      };
    },
  };
}

/**
 * The running sync service, installed once so the on-demand trigger and the timer share one
 * single-flight cell (two instances would run two syncs). Internal consumers read it back
 * through {@link gatewayKeyStateSyncControls}; `undefined` uninstalls (tests).
 */
let installed: GatewayKeyStateSyncService | undefined;

export function installGatewayKeyStateSyncService(
  service: GatewayKeyStateSyncService | undefined,
) {
  installed = service;
}

/** The installed sync service, or undefined in a process that never installed one. */
export function gatewayKeyStateSyncControls():
  | GatewayKeyStateSyncService
  | undefined {
  return installed;
}

/**
 * The timer seam the scheduler runs on. Injectable so a test advances the clock by hand; the
 * production answer is setTimeout/clearTimeout, unref'd — housekeeping must not hold the
 * process open.
 */
export type KeySyncSchedulerTimer = {
  schedule(run: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};

export function defaultKeySyncSchedulerTimer(): KeySyncSchedulerTimer {
  return {
    schedule(run, delayMs) {
      const handle = setTimeout(run, delayMs);
      handle.unref?.();
      return handle;
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

export type GatewayKeyStateSyncScheduler = {
  /**
   * Begin the cadence: the first sync fires one full period from now, then one per period.
   * Starting a started scheduler is a logged no-op — one timer, not two.
   */
  start(): void;
  /** Stop the cadence. Idempotent; a stopped scheduler fires nothing further. */
  stop(): void;
  /** The configured period, for the status surfaces. */
  readonly intervalMs: number;
};

export function createGatewayKeyStateSyncScheduler(options: {
  service: GatewayKeyStateSyncService;
  intervalMs: number;
  timer?: KeySyncSchedulerTimer;
  log?: Logger;
}): GatewayKeyStateSyncScheduler {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error(
      `The key state sync interval must be a positive whole number of milliseconds, got ${String(options.intervalMs)}.`,
    );
  }
  const log = options.log ?? getLogger("server");
  const timer = options.timer ?? defaultKeySyncSchedulerTimer();
  let handle: unknown;
  let started = false;

  const tick = () => {
    // Reschedule first, then fire: the cadence stays fixed, a dying sync cannot stop the
    // chain, and an overlap is harmless — the service single-flights concurrent runs.
    if (started) handle = timer.schedule(tick, options.intervalMs);
    void options.service
      .runSync()
      .then((outcome) => {
        if (outcome.status === "ok") {
          log.info(
            {
              type: "gateway-key-sync-ok",
              checked: outcome.checked,
              drifted: outcome.drifted.length,
              syncedAt: outcome.syncedAt,
            },
            "The automatic key state sync completed.",
          );
          return;
        }
        // The fixed reason code only — the failure's message, if any, never leaves the
        // layer that classified it.
        log.warn(
          {
            type: "gateway-key-sync-failed",
            stage: outcome.stage,
            reasonCode: outcome.reasonCode,
            failedAt: outcome.failedAt,
          },
          "The automatic key state sync failed; the last-good statuses are kept.",
        );
      })
      .catch((error: unknown) => {
        // Unreachable — a sync answers outcomes and records its own broken state writes —
        // but a scheduler that dies silently is worse than a redundant log line.
        log.error(
          {
            type: "gateway-key-sync-unexpected-error",
            errorName:
              error instanceof Error ? error.name : String(typeof error),
          },
          "The automatic key state sync failed unexpectedly.",
        );
      });
  };

  return {
    get intervalMs() {
      return options.intervalMs;
    },
    start() {
      if (started) {
        log.warn(
          { type: "gateway-key-sync-scheduler-already-started" },
          "The key state sync scheduler was started twice; the first timer stays.",
        );
        return;
      }
      started = true;
      handle = timer.schedule(tick, options.intervalMs);
    },
    stop() {
      started = false;
      if (handle !== undefined) {
        timer.cancel(handle);
        handle = undefined;
      }
    },
  };
}

/**
 * Assemble the sync service from the installed enterprise controls and start its scheduler —
 * the deployment wiring's whole job here, the twin of the catalog sync's start function. The
 * service is installed first, so an on-demand trigger resolves the very instance whose
 * single-flight cell the timer uses. Answers the sweeper (to `stop()` on shutdown), or
 * undefined when this process has no enterprise controls or no key state client — a test or
 * script that never wired the gateway has nothing to schedule, and saying so beats a timer
 * that refuses on every tick.
 */
export function startGatewayKeyStateSyncScheduler(options: {
  /** Pass when the caller already holds the instance (tests); otherwise assembled below. */
  service?: GatewayKeyStateSyncService;
  client?: GatewayKeyStateClient;
  database?: Database;
  /** The audit trail the field-drift alerts are written to (05.9); see the service deps. */
  auditStore?: AuditStore;
  /** Overrides the default one minute; validated like the environment value. */
  intervalMs?: number;
  /** Injectable timer for tests. */
  timer?: KeySyncSchedulerTimer;
  log?: Logger;
}): { stop(): void } | undefined {
  const log = options.log ?? getLogger("server");
  let service = options.service;
  if (service === undefined) {
    if (!options.client || !options.database) {
      log.info(
        { type: "gateway-key-sync-scheduler-absent" },
        "No key state client or database composed; the automatic key state sync is not scheduled.",
      );
      return undefined;
    }
    service = createGatewayKeyStateSyncService({
      database: options.database,
      client: options.client,
      store: createGatewayKeyStateStore(options.database),
      ...(options.auditStore === undefined ? {} : { auditStore: options.auditStore }),
      log,
    });
  }
  installGatewayKeyStateSyncService(service);
  // The cadence is configuration: an explicit option wins, otherwise the environment answers
  // (default one minute, the variable validated in one place — a deployment that misspells
  // the value stops here, loudly).
  const intervalMs =
    options.intervalMs ?? gatewayKeyStateSyncIntervalConfig(process.env);
  const scheduler = createGatewayKeyStateSyncScheduler({
    service,
    intervalMs,
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    log,
  });
  scheduler.start();
  log.info(
    { type: "gateway-key-sync-scheduler-started", intervalMs },
    "The automatic key state sync is scheduled.",
  );
  return {
    stop: () => scheduler.stop(),
  };
}

/*
 * THE HTTP ADAPTER. The same discipline the issuance and customer adapters keep: one request,
 * one deadline that covers the body read too, a byte cap on everything the peer sends, upstream
 * bytes read only to be validated and dropped, and a classification that never quotes the
 * gateway. A 404 is not a failure here — it is the deletion answer the sync exists to read.
 */

/** How much of a response body the adapter will read before it stops believing the peer. */
export const GATEWAY_KEY_STATE_MAX_BODY_BYTES = 512 * 1024;

function timeoutError(): Error {
  const error = new Error("The gateway key state request timed out.");
  error.name = "TimeoutError";
  return error;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

type CappedBody =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "unreadable" };

async function readBodyCapped(
  response: Response,
  capBytes: number,
): Promise<CappedBody> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > capBytes) {
    return { ok: false, reason: "too_large" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, reason: "unreadable" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      void reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The body of a refused response is worthless; a read failure changes nothing.
  }
}

/** The remote key object a read answer carries, read strictly: the switch, the term, and
 * the three fields 05.9 compares (owner, scope, narrowing configs). */
function keyStateFrom(json: unknown): GatewayKeyRemoteState | undefined {
  if (json === null || typeof json !== "object") return undefined;
  const key = (json as { virtual_key?: unknown }).virtual_key;
  if (key === null || typeof key !== "object") return undefined;
  // The id is the proof the answer names one key; nothing else is carried out.
  const id = (key as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  // A Go *bool with omitempty: absent means true. A present non-boolean is a management
  // answer this adapter does not believe — the caller classifies it as invalid.
  const rawActive = (key as { is_active?: unknown }).is_active;
  if (rawActive !== undefined && typeof rawActive !== "boolean") {
    return undefined;
  }
  const rawExpires = (key as { expires_at?: unknown }).expires_at;
  if (
    rawExpires !== undefined &&
    rawExpires !== null &&
    typeof rawExpires !== "string"
  ) {
    return undefined;
  }
  if (
    typeof rawExpires === "string" &&
    Number.isNaN(Date.parse(rawExpires))
  ) {
    return undefined;
  }
  // The owner (05.9): a Go *string with omitempty — absent means no customer owns it
  // here (a team, a business unit, or nothing), which is exactly what the comparison
  // must hear.
  const rawCustomer = (key as { customer_id?: unknown }).customer_id;
  if (rawCustomer !== undefined && rawCustomer !== null && typeof rawCustomer !== "string") {
    return undefined;
  }
  // The scope (05.9): a Go bool without omitempty — always present in a real answer,
  // read as false when a peer omits it (deny-by-default is also the honest default).
  const rawAllowAll = (key as { allow_all_providers?: unknown }).allow_all_providers;
  if (rawAllowAll !== undefined && typeof rawAllowAll !== "boolean") {
    return undefined;
  }
  // The per-provider narrowing (05.9): a Go slice — an array, or null when nil. Anything
  // else is a management answer this adapter does not believe.
  const rawConfigs = (key as { provider_configs?: unknown }).provider_configs;
  if (
    rawConfigs !== undefined &&
    rawConfigs !== null &&
    !Array.isArray(rawConfigs)
  ) {
    return undefined;
  }
  return {
    isActive: rawActive === undefined ? true : rawActive,
    expiresAt: typeof rawExpires === "string" ? rawExpires : null,
    customerId: typeof rawCustomer === "string" ? rawCustomer : null,
    allowAllProviders: rawAllowAll === undefined ? false : rawAllowAll,
    providerConfigCount: Array.isArray(rawConfigs) ? rawConfigs.length : 0,
  };
}

export type GatewayVirtualKeyStateClientDeps = {
  /** 01.1: the current endpoint snapshot, or undefined when none is configured. */
  readGatewayEndpoint: () => Promise<
    { baseUrl: string; requestTimeoutMs: number } | undefined
  >;
  /** 01.2's internal resolve — the only place the admin key's plaintext may come from. */
  resolveGatewayAdminCredential: () => Promise<{ adminKey: string }>;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
};

/**
 * The production transport for {@link GatewayKeyStateClient}: one authenticated read of one
 * key's governance record per call, classified into the module's fixed reason codes. The
 * answer carries no key value (the management read never returns one this adapter keeps —
 * anything beyond `id`, the switch and the expiry is validated and dropped).
 */
export function createGatewayVirtualKeyStateClient(
  deps: GatewayVirtualKeyStateClientDeps,
): GatewayKeyStateClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async getVirtualKeyState({ gatewayVirtualKeyId }) {
      const config = await deps.readGatewayEndpoint();
      if (!config) {
        throw new GatewayKeyStateError(
          "gateway_key_sync_endpoint_not_configured",
          "No gateway address is configured, so the key state read is refused.",
        );
      }
      let adminKey: string;
      try {
        adminKey = (await deps.resolveGatewayAdminCredential()).adminKey;
      } catch {
        throw new GatewayKeyStateError(
          "gateway_key_sync_credential_unavailable",
          "The gateway admin credential could not be resolved, so the key state read is refused.",
        );
      }

      const url = new URL(
        `/api/governance/virtual-keys/${encodeURIComponent(gatewayVirtualKeyId)}`,
        config.baseUrl,
      );
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${adminKey}` },
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new GatewayKeyStateError(
            "gateway_key_sync_timeout",
            "The gateway did not answer the key state read before the deadline, so the sync is refused.",
          );
        }
        throw new GatewayKeyStateError(
          "gateway_key_sync_unreachable",
          "No connection to the gateway's key governance surface was established, so the sync is refused.",
        );
      }

      if (response.status === 401 || response.status === 403) {
        await discardBody(response);
        throw new GatewayKeyStateError(
          "gateway_key_sync_unauthenticated",
          "The gateway refused the admin credential for the key governance surface, so the sync is refused.",
        );
      }

      // The deletion answer: the key is gone from the gateway's governance. A body read is
      // still owed to the connection, but the verdict does not wait on its contents.
      if (response.status === 404) {
        await discardBody(response);
        return { found: false };
      }

      const remainingMs = config.requestTimeoutMs - (Date.now() - startedAt);
      // The body-read deadline: the timer is cleared once the race settles, so a fast body
      // leaves no live timer behind (review F2).
      let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
      const capped = await Promise.race([
        readBodyCapped(response, GATEWAY_KEY_STATE_MAX_BODY_BYTES),
        new Promise<never>((_, reject) => {
          deadlineHandle = setTimeout(
            () => reject(timeoutError()),
            Math.max(1, remainingMs),
          );
        }),
      ])
        .finally(() => {
          if (deadlineHandle !== undefined) clearTimeout(deadlineHandle);
        })
        .catch((error: unknown) => {
        if (isTimeoutError(error)) return null;
        throw new GatewayKeyStateError(
          "gateway_key_sync_invalid_response",
          "The gateway's key state response could not be read, so the sync is refused.",
        );
      });

      if (capped === null) {
        throw new GatewayKeyStateError(
          "gateway_key_sync_timeout",
          "The gateway did not finish the key state response before the deadline, so the sync is refused.",
        );
      }
      if (!capped.ok) {
        throw new GatewayKeyStateError(
          "gateway_key_sync_invalid_response",
          "The gateway's key state response was not a readable management answer, so the sync is refused.",
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(capped.text);
      } catch {
        throw new GatewayKeyStateError(
          "gateway_key_sync_invalid_response",
          "The gateway's key state response was not JSON, so the sync is refused.",
        );
      }
      if (response.status < 200 || response.status > 299) {
        void json; // validated and dropped
        throw new GatewayKeyStateError(
          "gateway_key_sync_unexpected_status",
          "The gateway answered the key state read with an unexpected status, so the sync is refused.",
        );
      }
      const state = keyStateFrom(json);
      if (!state) {
        throw new GatewayKeyStateError(
          "gateway_key_sync_invalid_response",
          "The gateway's key state answer carried no usable key state, so the sync is refused.",
        );
      }
      return { found: true, state };
    },
  };
}
