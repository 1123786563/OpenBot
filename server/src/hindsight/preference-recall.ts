/**
 * Hindsight 05 (#382): semantic recall of confirmed general personal preferences, across Bots
 * of the same company.
 *
 * This module is the recall seam the spec names as the personal memory module's ONLY public
 * entry for this behavior. Its contract is deliberately narrow: a Bot asks with a query and
 * receives confirmed originals — OpenBot record id, content, provenance, marking time. No bank
 * id and no remote document id ever appears in what it returns, and no caller-supplied
 * placement exists: the Hindsight bank comes from `resolveHindsightBankScope` (#381), the one
 * derived-isolation seam, which accepts nothing but a server-issued trusted scope. The same
 * global user holding principals in two companies therefore recalls from two different banks
 * in two different schemas, and another user's bank is not this caller's to name.
 *
 * Division of labor, per the parent spec (#376) and ADR 0005: Hindsight indexes and ranks; it
 * never answers content. A recall takes ONLY the hit list's `document_id`s (in rank order)
 * from the service — the extracted fact text, observations and any reflect output the response
 * also carries are read past, never surfaced — and re-loads each mapped row from the OpenBot
 * authority table, where the row must STILL be current: not forgotten, enabled, and confirmed
 * or edited. A hit with no row (orphan, or a document retained straight into the bank outside
 * this seam), a row whose review state no longer qualifies, or a document id this caller's
 * rows do not own is dropped before anything reaches the Bot. The confirmed original the Bot
 * receives is therefore always the bytes OpenBot holds, re-checked at read time.
 *
 * Sync is the same discipline in miniature: confirming a preference retains it under a stable
 * document identity derived once from the row (so an edit replaces the remote document in
 * place rather than leaving a stale twin), and the row records the digest of the content last
 * retained. A retain failure never fails the person's confirmation — the row simply stays
 * pending its first sync; the retry queue that drains such rows is #384, and safe degradation
 * when the whole service is down is #385, which is why recall here reports unavailability as
 * an error instead of quietly answering empty.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getLogger } from "../../../shared/logger";
import type { Database } from "../db/client";
import { genericPersonalPreferences } from "../db/schema/hindsight-preferences";
import type { PlatformScope } from "../enterprise/contracts";
import {
  type HindsightBankScope,
  mintBankScopeAssertion,
  resolveHindsightBankScope,
} from "./bank-scope";
import type { HindsightBudgetGate } from "./budget-gate";
import { type HindsightPauseControls, usagePausedFor } from "./pause-controls";
import { type HindsightRecoveryGate, recallOpenFor } from "./restore-recovery";
import {
  type MemoryRevocationStatus,
  type PersonalMemoryRevocationRecorder,
  STOPPED_USING_SUMMARY,
} from "./revocation-ledger";
import { assertMemoryContentAdmissible } from "./sensitivity-gate";

/** What a Bot receives: the confirmed original, and nothing remote-derived. */
export type RecalledGenericPreference = {
  /** The OpenBot record id — the only id this seam's contract carries. */
  id: string;
  /** The confirmed original text, re-loaded from OpenBot at recall time. */
  content: string;
  provenance: string;
  /** When the person explicitly marked this preference as general. */
  markedGenericAt: Date;
  /**
   * When this fact began to apply (Hindsight 09 / #386). Null = the start could not be
   * determined — the answer carries that uncertainty, never a fabricated date.
   */
  effectiveFrom: Date | null;
  /** When this fact stopped applying; null = still open (the current fact). */
  effectiveUntil: Date | null;
  /**
   * The temporal answer is not sure of itself: either the fact's start is unknown (current
   * question), or the asked-about moment falls where a correction's time is unknown
   * (historical question). The Bot expresses the uncertainty instead of guessing a date.
   */
  timeUncertain: boolean;
};

/** The authority row, in full; internal to the module and its tests. */
export type PreferenceAuthorityRow = {
  tenantId: string;
  id: string;
  principalId: string;
  content: string;
  provenance: string;
  reviewState: "unreviewed" | "confirmed" | "edited";
  enabled: boolean;
  deletedAt: Date | null;
  markedGenericAt: Date;
  hindsightDocumentId: string;
  syncedContentDigest: string | null;
  syncedAt: Date | null;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  supersededBy: string | null;
  supersededTimeUnknown: boolean;
  correctedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The persistence port. All policy — review gates, tombstones, digests — lives in the service
 * above this interface, so the SQL-backed implementation below and the in-memory one the
 * real-instance contract test uses cannot drift apart on what a recall must still verify.
 */
export interface PreferenceRecordStore {
  create(row: PreferenceAuthorityRow): Promise<void>;
  load(tenantId: string, id: string): Promise<PreferenceAuthorityRow | null>;
  /** Full-row update by (tenantId, id); the id and document identity never change. */
  save(row: PreferenceAuthorityRow): Promise<void>;
  /** Rows of THIS principal in THIS company holding these document ids. */
  loadByDocumentIds(
    tenantId: string,
    principalId: string,
    documentIds: readonly string[],
  ): Promise<PreferenceAuthorityRow[]>;
  /**
   * This principal's living rows in this company, newest change first (FIX-W12 FR2-3): the raw
   * feed the answer-basis listing filters further — the service decides eligibility, the store
   * only narrows to the principal's own, not-yet-forgotten rows.
   */
  listLiving(
    tenantId: string,
    principalId: string,
    limit: number,
  ): Promise<PreferenceAuthorityRow[]>;
}

/** How the service reaches the shared self-hosted Hindsight instance. */
export type PreferenceRecallServiceConfig = {
  /** Base origin of the Hindsight API, e.g. http://127.0.0.1:8888. No path, no credentials. */
  apiUrl: string;
  /** The deployment's shared service key (Bearer), paired with a per-request assertion. */
  serviceApiKey: string;
  /** The assertion secret shared with the service's tenant extension (bank-scope.ts). */
  assertionSecret: string;
  requestTimeoutMs?: number;
  /** Injectable for tests; the real calls use the platform's fetch with a timeout. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

/** The environment the service configuration is read from. */
export type PreferenceRecallEnv = Record<string, string | undefined>;

export class PreferenceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreferenceRefusedError";
  }
}

export class PreferenceNotFoundError extends Error {
  constructor() {
    super("This general personal preference could not be found.");
    this.name = "PreferenceNotFoundError";
  }
}

/** The Hindsight service could not be asked; the safe-degradation path (#385) catches this. */
export class PreferenceRecallUnavailableError extends Error {
  constructor() {
    super(
      "The memory index is unreachable right now; confirmed preferences are unchanged and will recall once it is back.",
    );
    this.name = "PreferenceRecallUnavailableError";
  }
}

/** How long one minted assertion stays valid; fresh per request, so short is correct. */
const ASSERTION_TTL_MS = 60_000;
/** The pinned deployment is single-tenant on the service side; the segment is a constant. */
const HINDSIGHT_TENANT_SEGMENT = "default";
const CONTENT_MAX = 6000;
const PROVENANCE_MAX = 500;
const QUERY_MAX = 512;
/** Bot-context economy: recall answers at most this many confirmed originals. */
const RECALL_LIMIT = 20;

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

function hash16(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`${namespace}:${value}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The stable document identity of one preference row. Deterministic over the row's own
 * (tenant, id), so the same row always indexes as the same document and no derivation output
 * can collide with another subject's — the same discipline bank ids follow in bank-scope.ts.
 */
export function preferenceDocumentIdFor(
  tenantId: string,
  recordId: string,
): string {
  return `hgp_${hash16("generic-preference", `${tenantId}:${recordId}`)}`;
}

/**
 * Read the service configuration from the environment, refusing anything misdeclared rather
 * than defaulting it: a defaulted URL or key would send confirmed preferences to the wrong
 * service, and a defaulted secret would mint assertions the service rightly refuses.
 */
export function preferenceRecallConfigFromEnv(
  env: PreferenceRecallEnv = process.env,
): PreferenceRecallServiceConfig {
  const apiUrl = env.HINDSIGHT_API_URL?.trim();
  if (!apiUrl)
    throw new Error("HINDSIGHT_API_URL is required and is not configured.");
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("HINDSIGHT_API_URL must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HINDSIGHT_API_URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("HINDSIGHT_API_URL must not carry credentials in the URL.");
  }
  const serviceApiKey = env.HINDSIGHT_API_TOKEN?.trim();
  if (!serviceApiKey) {
    throw new Error("HINDSIGHT_API_TOKEN is required and is not configured.");
  }
  const assertionSecret = env.HINDSIGHT_BANK_ASSERTION_SECRET?.trim();
  if (!assertionSecret) {
    throw new Error(
      "HINDSIGHT_BANK_ASSERTION_SECRET must declare the secret shared with the Hindsight service's tenant extension before preferences can be indexed or recalled.",
    );
  }
  const requestTimeoutMs = Number(env.HINDSIGHT_REQUEST_TIMEOUT_MS ?? 5000);
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(
      "HINDSIGHT_REQUEST_TIMEOUT_MS must be a positive number of milliseconds.",
    );
  }
  return {
    apiUrl: parsed.origin,
    serviceApiKey,
    assertionSecret,
    requestTimeoutMs,
  };
}

function plainString(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new PreferenceRefusedError(
      `A general personal preference needs ${field} of 1..${max} characters.`,
    );
  }
  return value;
}

/**
 * Map a database row to the contract a Bot sees: no bank, no document id, no sync state.
 * Exported because the safe-degradation recall (#385) answers with the SAME view — a second
 * mapper is where a looser copy would start.
 */
export const toRecalledPreferenceView = (
  row: PreferenceAuthorityRow,
  timeUncertain = false,
): RecalledGenericPreference => ({
  id: row.id,
  content: row.content,
  provenance: row.provenance,
  markedGenericAt: row.markedGenericAt,
  effectiveFrom: row.effectiveFrom,
  effectiveUntil: row.effectiveUntil,
  timeUncertain,
});

/**
 * A row a recall may still hand to a Bot: live, on, and confirmed or edited. Exported for the
 * same single-source reason as the view mapper above.
 */
export const preferenceRecallEligible = (row: PreferenceAuthorityRow) =>
  row.deletedAt === null &&
  row.enabled &&
  (row.reviewState === "confirmed" || row.reviewState === "edited") &&
  row.content !== "";

/**
 * Whether the row's validity window covers the asked-about moment (Hindsight 09 / #386).
 *
 * A CURRENT question reads the chain head — not superseded, and already effective; a fact
 * whose start is unknown still answers, flagged uncertain. A HISTORICAL question needs a
 * known start at or before the moment; an open window on the chain head covers any past
 * moment, and a window closed at an UNKNOWN time surfaces uncertain inside the ambiguity
 * rather than pretending to know the transition. Unconfirmed changes never get here at all
 * (the review gate); a tombstone answers neither kind of question.
 */
export function temporallyVisible(
  row: PreferenceAuthorityRow,
  at: Date,
  mode: "current" | "historical",
): boolean {
  if (mode === "current") {
    if (row.effectiveFrom !== null && row.effectiveFrom > at) return false;
    if (row.effectiveUntil !== null) return row.effectiveUntil > at;
    if (row.supersededBy === null) return true;
    // Closed at an UNKNOWN time: the old fact was current until the correction was decided;
    // from the decision on, the successor owns the current answer.
    return row.correctedAt !== null && at < row.correctedAt;
  }
  if (row.effectiveFrom === null) return false;
  if (row.effectiveFrom > at) return false;
  if (row.effectiveUntil !== null) return row.effectiveUntil > at;
  if (row.supersededBy === null) return true;
  // Closed at an unknown time in (from, correctedAt]: inside that span the old fact is the
  // honest answer, flagged uncertain (when exactly it changed cannot be known); past the
  // decision moment the change has certainly happened, and the successor answers instead.
  return (
    row.supersededTimeUnknown &&
    row.correctedAt !== null &&
    at <= row.correctedAt
  );
}

/** The uncertainty flag for a visible row: unknown start (current) or unknown close (past). */
export function timeUncertaintyOf(
  row: PreferenceAuthorityRow,
  mode: "current" | "historical",
): boolean {
  if (mode === "current") return row.effectiveFrom === null;
  return (
    row.supersededBy !== null &&
    row.effectiveUntil === null &&
    row.supersededTimeUnknown
  );
}

/**
 * The durable sync-work recorder #384 attaches; structural, so the sync queue satisfies it
 * without this module importing it. Recording happens on the confirm/edit paths — the work
 * row is the durable "this confirmed content should reach Hindsight" intent the queue drains.
 */
export interface PreferenceWorkRecorder {
  record(input: {
    subjectType: "preference";
    tenantId: string;
    subjectId: string;
    principalId: string;
    contentDigest: string;
  }): Promise<void>;
}

export function createPreferenceRecallService(
  store: PreferenceRecordStore,
  config: PreferenceRecallServiceConfig,
  options: {
    now?: () => Date;
    work?: PreferenceWorkRecorder;
    /** The durable revocation ledger #390 attaches; without it the status stays honest anyway. */
    revocations?: PersonalMemoryRevocationRecorder;
    /** The person's pause switches (#392); usage-paused answers recall empty before any remote call. */
    pause?: HindsightPauseControls;
    /**
     * The backup-restore recovery gate (#391): while a restore awaits its revocation replay,
     * recall answers empty — before any remote call, like the pause switch, so the SQL
     * degradation path (whose rows a restore may have resurrected) never runs either.
     */
    recovery?: HindsightRecoveryGate;
    /**
     * The background-processing budget gate (#393, FIX-F23 / FR-2). The confirm/edit/
     * correction eager retains are model-call paths exactly like the judgment review's, and
     * they admit through the same gate the sync queue's drains do: exhaustion skips the
     * retain — the person's confirmation stands and the work row keeps the retry — and an
     * admitted retain settles when the service answered (a refusal did the work) and
     * releases when it was never reached, the queue's discipline.
     */
    budget?: HindsightBudgetGate;
  } = {},
) {
  const log = getLogger("server");
  const now = options.now ?? (() => new Date());
  const doFetch =
    config.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

  /**
   * One authenticated call into the shared Hindsight service: the deployment's service key
   * paired with a freshly minted assertion carrying exactly this grant. Neither half alone
   * authenticates anything on memory routes (#381's contract).
   */
  async function hindsight(
    grant: HindsightBankScope,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const token = mintBankScopeAssertion(grant, {
      secret: config.assertionSecret,
      ttlMs: ASSERTION_TTL_MS,
      now: now(),
    });
    return doFetch(`${config.apiUrl}${path}`, {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.serviceApiKey}`,
        "x-openbot-bank-scope": token,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? 5000),
    });
  }

  /**
   * One best-effort remote delete whose outcome is observable (#390): `attempted` is false
   * exactly when the service could not be reached, and `confirmed` is true on 2xx or 404 (a
   * document the service no longer knows is as deleted as one it just removed). Never thrown
   * — the authority row already stopped every use before this ran.
   */
  async function deleteDocument(
    grant: HindsightBankScope,
    documentId: string,
  ): Promise<{
    attempted: boolean;
    confirmed: boolean;
    error: string | null;
  }> {
    try {
      const response = await hindsight(
        grant,
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${grant.banks[0].id}/documents/${encodeURIComponent(documentId)}`,
        { method: "DELETE" },
      );
      const confirmed = response.ok || response.status === 404;
      return {
        attempted: true,
        confirmed,
        error: confirmed ? null : `service answered ${response.status}`,
      };
    } catch (error) {
      return {
        attempted: false,
        confirmed: false,
        error:
          error instanceof Error
            ? error.message
            : "service could not be reached",
      };
    }
  }

  /**
   * Retain one row's confirmed content under its stable document identity. `replace` makes the
   * retain idempotent per document: an edit supersedes what the service held instead of
   * appending a second copy. A non-2xx answer is reported, never thrown — the authority row
   * stands on its own and simply stays pending its sync (#384 drains those). `reached` says
   * which of the two happened, so a budgeted caller can settle the one and release the other.
   */
  async function retain(
    grant: HindsightBankScope,
    row: PreferenceAuthorityRow,
  ): Promise<{ synced: boolean; reached: boolean }> {
    try {
      const response = await hindsight(
        grant,
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${grant.banks[0].id}/memories`,
        {
          body: {
            items: [
              {
                content: row.content,
                document_id: row.hindsightDocumentId,
                update_mode: "replace",
              },
            ],
          },
        },
      );
      if (!response.ok) return { synced: false, reached: true };
      row.syncedContentDigest = digestOf(row.content);
      row.syncedAt = now();
      return { synced: true, reached: true };
    } catch {
      return { synced: false, reached: false };
    }
  }

  /**
   * The eager retain behind a confirm/edit/correction, admitted through the budget gate when
   * one is wired (#393, FIX-F23 / FR-2 — the seam the final review caught bypassing it). An
   * exhausted budget does NOT fail the person's decision: the retain is skipped,
   * `remoteSynced` answers false and the work row recorded just above owns the retry — the
   * drain re-admits it under its own work key once the budget recovers, so an exhausted
   * decision charges nothing here. The admission key is stable per row and confirmed
   * content: re-asserting the same text re-admits one reservation (charged once), while an
   * edit's new text is genuinely new processing and honestly separate — the judgment
   * review's `admittedRetain` discipline.
   *
   * FIX-OCR3 (O3-M1): "verbatim" now includes the bookkeeping guard the judgment review
   * gained in O2-M1 — the admission and settle/release calls are local DB writes that run
   * after the authority row and work row already landed, so their failure degrades, never
   * fails the confirm a retry would then hit as "already confirmed".
   */
  async function admittedRetain(
    grant: HindsightBankScope,
    row: PreferenceAuthorityRow,
  ): Promise<boolean> {
    if (!options.budget) return (await retain(grant, row)).synced;
    let admission: Awaited<
      ReturnType<HindsightBudgetGate["admitBackgroundWork"]>
    >;
    try {
      admission = await options.budget.admitBackgroundWork({
        tenantId: grant.tenantId,
        principalId: grant.principalId,
        workKey: `preference-eager:${row.id}:${digestOf(row.content)}`,
        units: 1,
      });
    } catch {
      log.error(
        {
          type: "preference-eager-budget-admit-failed",
          context: { rowId: row.id },
          timestamp: new Date().toISOString(),
        },
        "preference-eager-budget-admit-failed",
      );
      return false;
    }
    if (!admission.ok) return false;
    const outcome = await retain(grant, row);
    try {
      if (outcome.synced) {
        await options.budget.settleBackgroundWork(admission.reservationId);
        return true;
      }
      if (outcome.reached) {
        // The service answered and refused: it did the work, the charge stands — the same
        // split the sync queue's retains draw.
        await options.budget.settleBackgroundWork(admission.reservationId);
      } else {
        await options.budget.releaseBackgroundWork(
          admission.reservationId,
          "eager retain could not reach the service",
        );
      }
      return false;
    } catch {
      log.error(
        {
          type: "preference-eager-budget-bookkeeping-failed",
          context: { rowId: row.id, reservationId: admission.reservationId },
          timestamp: new Date().toISOString(),
        },
        "preference-eager-budget-bookkeeping-failed",
      );
      // The retain itself already answered; only its ledger entry is unsound. The decision
      // stands with the outcome the service gave, and the reservation the failed call left
      // behind is the period's to age out.
      return outcome.synced;
    }
  }

  return {
    /**
     * Confirm a preference and mark it general: the person's explicit double decision. The row
     * is created confirmed and retained to Hindsight under its derived document identity; the
     * marking time records the decision. `remoteSynced` tells the caller whether this content
     * is indexed yet — false never invalidates the confirmation.
     */
    async confirmGenericPreference(
      scope: PlatformScope,
      input: {
        content: unknown;
        provenance?: unknown;
        /** The person's explicit second confirmation for sensitive content (F-G1-4). */
        confirmSensitive?: unknown;
      },
    ): Promise<{
      record: RecalledGenericPreference;
      remoteSynced: boolean;
    }> {
      const grant = resolveHindsightBankScope(scope);
      const content = plainString(input.content, "content", CONTENT_MAX);
      // The chain-side sensitivity gate (audit F-G1-4): the same classifier the personal
      // store applies. Credentials never store; sensitive classes need the second confirmation.
      assertMemoryContentAdmissible(content, input.confirmSensitive);
      const provenance = plainString(
        input.provenance ?? "You",
        "provenance",
        PROVENANCE_MAX,
      );
      // Authority first: the row exists before anything leaves for the service, so a retain
      // that never completes leaves a pending row, never an indexed orphan.
      const id = randomUUID();
      const at = now();
      const row: PreferenceAuthorityRow = {
        tenantId: grant.tenantId,
        id,
        principalId: grant.principalId,
        content,
        provenance,
        reviewState: "confirmed",
        enabled: true,
        deletedAt: null,
        markedGenericAt: at,
        hindsightDocumentId: preferenceDocumentIdFor(grant.tenantId, id),
        syncedContentDigest: null,
        syncedAt: null,
        // Validity begins at confirmation — the fact's OpenBot birth, the one start that is
        // always known. Earlier validity was never established and is never back-claimed.
        effectiveFrom: at,
        effectiveUntil: null,
        supersededBy: null,
        supersededTimeUnknown: false,
        correctedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      await store.create(row);
      if (options.work) {
        await options.work.record({
          subjectType: "preference",
          tenantId: row.tenantId,
          subjectId: row.id,
          principalId: row.principalId,
          contentDigest: digestOf(row.content),
        });
      }
      const remoteSynced = await admittedRetain(grant, row);
      if (remoteSynced) await store.save(row);
      return { record: toRecalledPreferenceView(row), remoteSynced };
    },

    /**
     * Edit the confirmed original. The document identity stays put, so the retain replaces the
     * indexed document in place; an edit is itself a review act, so the row stays recallable
     * as `edited`.
     */
    async editGenericPreference(
      scope: PlatformScope,
      id: string,
      input: {
        content: unknown;
        /** The person's explicit second confirmation for sensitive content (F-G1-4). */
        confirmSensitive?: unknown;
      },
    ): Promise<{ record: RecalledGenericPreference; remoteSynced: boolean }> {
      const grant = resolveHindsightBankScope(scope);
      const content = plainString(input.content, "content", CONTENT_MAX);
      // An edit may not walk a credential in through the back door either — same gate as confirm.
      assertMemoryContentAdmissible(content, input.confirmSensitive);
      const row = await store.load(grant.tenantId, id);
      if (
        !row ||
        row.principalId !== grant.principalId ||
        row.deletedAt !== null
      )
        throw new PreferenceNotFoundError();
      row.content = content;
      row.reviewState = "edited";
      row.updatedAt = now();
      if (options.work) {
        await options.work.record({
          subjectType: "preference",
          tenantId: row.tenantId,
          subjectId: row.id,
          principalId: row.principalId,
          contentDigest: digestOf(row.content),
        });
      }
      const remoteSynced = await admittedRetain(grant, row);
      await store.save(row);
      return { record: toRecalledPreferenceView(row), remoteSynced };
    },

    /**
     * Correct a time-varying fact (Hindsight 09 / #386). The correction is explicit and the
     * old fact is NOT deleted: it keeps its confirmed content and gains a validity window
     * closed at the person's stated effective time — or, when no time could be determined, an
     * open window flagged `supersededTimeUnknown`, which historical reads inside the ambiguity
     * surface as uncertainty rather than a guessed date. The successor row is a NEW confirmed
     * fact under its own document identity (so both versions stay recallable: current
     * questions find the successor, historical questions find the predecessor), and only the
     * successor is retained now — the predecessor's content did not change, so its remote
     * document stands as indexed. Correcting a row that is itself superseded is refused: the
     * chain has one head, and the person corrects the current fact.
     */
    async correctGenericPreference(
      scope: PlatformScope,
      id: string,
      input: {
        content: unknown;
        effectiveFrom?: unknown;
        /** The person's explicit second confirmation for sensitive content (F-G1-4). */
        confirmSensitive?: unknown;
      },
    ): Promise<{
      record: RecalledGenericPreference;
      superseded: RecalledGenericPreference;
      remoteSynced: boolean;
    }> {
      const grant = resolveHindsightBankScope(scope);
      const content = plainString(input.content, "content", CONTENT_MAX);
      // A correction IS a new confirmed fact, so it answers to the same sensitivity gate.
      assertMemoryContentAdmissible(content, input.confirmSensitive);
      let effectiveFrom: Date | null = null;
      if (input.effectiveFrom !== undefined) {
        const parsed =
          input.effectiveFrom instanceof Date
            ? input.effectiveFrom
            : typeof input.effectiveFrom === "string"
              ? new Date(input.effectiveFrom)
              : null;
        if (!parsed || Number.isNaN(parsed.getTime())) {
          throw new PreferenceRefusedError(
            "A correction's effective time must be a date.",
          );
        }
        effectiveFrom = parsed;
      }
      const row = await store.load(grant.tenantId, id);
      if (
        !row ||
        row.principalId !== grant.principalId ||
        row.deletedAt !== null
      )
        throw new PreferenceNotFoundError();
      if (row.supersededBy !== null) {
        throw new PreferenceRefusedError(
          "This fact was already corrected; correct the current fact instead.",
        );
      }
      // A stated time must fall strictly inside the old fact's own window: a correction
      // cannot take effect at or before the moment the old fact began.
      if (
        effectiveFrom !== null &&
        row.effectiveFrom !== null &&
        effectiveFrom <= row.effectiveFrom
      ) {
        throw new PreferenceRefusedError(
          "A correction cannot take effect at or before the old fact began.",
        );
      }
      const at = now();
      const successorId = randomUUID();
      row.effectiveUntil = effectiveFrom;
      row.supersededBy = successorId;
      row.supersededTimeUnknown = effectiveFrom === null;
      row.correctedAt = at;
      row.updatedAt = at;
      const successor: PreferenceAuthorityRow = {
        tenantId: grant.tenantId,
        id: successorId,
        principalId: grant.principalId,
        content,
        provenance: row.provenance,
        reviewState: "confirmed",
        enabled: true,
        deletedAt: null,
        markedGenericAt: at,
        hindsightDocumentId: preferenceDocumentIdFor(
          grant.tenantId,
          successorId,
        ),
        syncedContentDigest: null,
        syncedAt: null,
        effectiveFrom,
        effectiveUntil: null,
        supersededBy: null,
        supersededTimeUnknown: false,
        correctedAt: null,
        createdAt: at,
        updatedAt: at,
      };
      await store.create(successor);
      await store.save(row);
      if (options.work) {
        await options.work.record({
          subjectType: "preference",
          tenantId: successor.tenantId,
          subjectId: successor.id,
          principalId: successor.principalId,
          contentDigest: digestOf(successor.content),
        });
      }
      const remoteSynced = await admittedRetain(grant, successor);
      if (remoteSynced) await store.save(successor);
      return {
        record: toRecalledPreferenceView(successor, effectiveFrom === null),
        superseded: toRecalledPreferenceView(row),
        remoteSynced,
      };
    },

    /**
     * Forget a preference: tombstoned the way the personal memory store forgets (content
     * cleared, disabled), so no later recall of the same document can resurrect it, and the
     * remote document is deleted best-effort. Since #390 the answer is the honest two-part
     * status: the block took effect at `stoppedUsingAt` — before any remote call was
     * initiated, so a Hindsight outage delays only the cleanup — and the remote deletion is
     * reported separately (`outstanding` while unconfirmed, never claimed cleared; the
     * deletion-evidence track owns that claim). The revocation ledger, when attached, records
     * the block and the deletion outcome for the retry drain and the backup-restore replay.
     */
    async forgetGenericPreference(
      scope: PlatformScope,
      id: string,
    ): Promise<MemoryRevocationStatus> {
      const grant = resolveHindsightBankScope(scope);
      const row = await store.load(grant.tenantId, id);
      if (
        !row ||
        row.principalId !== grant.principalId ||
        row.deletedAt !== null
      )
        throw new PreferenceNotFoundError();
      const stoppedUsingAt = now();
      const documentId = row.hindsightDocumentId;
      // The durable block FIRST: the tombstone and the ledger row land before anything
      // leaves for the service.
      row.deletedAt = stoppedUsingAt;
      row.enabled = false;
      row.content = "";
      row.syncedContentDigest = null;
      row.syncedAt = null;
      row.updatedAt = stoppedUsingAt;
      await store.save(row);
      if (options.revocations) {
        await options.revocations.recordBlock({
          tenantId: grant.tenantId,
          principalId: grant.principalId,
          kind: "memory",
          subjectType: "preference",
          targetId: row.id,
          documentId,
          bankId: grant.banks[0].id,
          bankKind: "user",
          blockedAt: stoppedUsingAt,
        });
      }
      const deletion = await deleteDocument(grant, documentId);
      if (options.revocations) {
        await options.revocations.noteDeletionOutcome({
          tenantId: grant.tenantId,
          documentId,
          attemptedAt: now(),
          confirmed: deletion.confirmed,
          error: deletion.error,
        });
      }
      return {
        stoppedUsingAt,
        remoteDeletion: {
          attempted: deletion.attempted,
          outstanding: deletion.confirmed ? 0 : 1,
        },
        summary: STOPPED_USING_SUMMARY,
      };
    },

    /**
     * THE recall seam: Hindsight ranks, OpenBot answers. Only the hit list's document ids (in
     * rank order) are taken from the service; every extracted fact text, observation and
     * reflect output the response carries is read past. Each id is then resolved against this
     * principal's current rows in this company, and anything without a live, enabled,
     * confirmed-or-edited row is dropped. Cross-company and cross-user isolation ride the bank
     * derivation itself (#381): the answer below is defense in depth, not the boundary.
     */
    async recallGenericPreferences(
      scope: PlatformScope,
      input: { query: unknown; askingAgentId?: unknown; asOf?: unknown },
    ): Promise<RecalledGenericPreference[]> {
      const grant = resolveHindsightBankScope(scope);
      // Pause-usage (#392) and the backup-restore gate (#391) run FIRST, before any input is
      // parsed: a paused or restore-closed person gets the promised empty answer even for a
      // malformed query, and the refusal path never discloses whether the gate was shut.
      if (await usagePausedFor(options.pause, scope)) return [];
      if (!(await recallOpenFor(options.recovery))) return [];
      const query = plainString(input.query, "a query", QUERY_MAX).trim();
      if (input.askingAgentId !== undefined) {
        plainString(input.askingAgentId, "an asking agent id", 128);
      }
      // The asked-about moment: absent = a current question; present = a historical one.
      let asOf: Date | undefined;
      if (input.asOf !== undefined) {
        const parsed =
          input.asOf instanceof Date
            ? input.asOf
            : typeof input.asOf === "string"
              ? new Date(input.asOf)
              : null;
        if (!parsed || Number.isNaN(parsed.getTime())) {
          throw new PreferenceRefusedError("An as-of time must be a date.");
        }
        asOf = parsed;
      }
      const mode: "current" | "historical" =
        asOf === undefined ? "current" : "historical";
      let response: Response;
      try {
        response = await hindsight(
          grant,
          `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${grant.banks[0].id}/memories/recall`,
          { body: { query } },
        );
      } catch {
        throw new PreferenceRecallUnavailableError();
      }
      // A bank the service has never seen is a person who has confirmed nothing yet — that
      // is an empty recall, not an outage; the bank appears on the first retain.
      if (response.status === 404) return [];
      if (!response.ok) throw new PreferenceRecallUnavailableError();
      const payload = (await response.json().catch(() => null)) as {
        results?: { document_id?: unknown }[];
      } | null;
      // Document ids only, first-seen order: the service's ranking, nothing else.
      const ranked: string[] = [];
      const seen = new Set<string>();
      for (const hit of payload?.results ?? []) {
        const documentId = hit?.document_id;
        if (typeof documentId !== "string" || seen.has(documentId)) continue;
        seen.add(documentId);
        ranked.push(documentId);
      }
      if (!ranked.length) return [];
      const rows = await store.loadByDocumentIds(
        grant.tenantId,
        grant.principalId,
        ranked,
      );
      const byDocument = new Map(
        rows.map((row) => [row.hindsightDocumentId, row]),
      );
      return ranked
        .flatMap((documentId) => {
          const row = byDocument.get(documentId);
          return row &&
            preferenceRecallEligible(row) &&
            temporallyVisible(row, asOf ?? now(), mode)
            ? [toRecalledPreferenceView(row, timeUncertaintyOf(row, mode))]
            : [];
        })
        .slice(0, RECALL_LIMIT);
    },
  };
}

export type PreferenceRecallService = ReturnType<
  typeof createPreferenceRecallService
>;

/** The SQL-backed record store: mechanical persistence only, all policy lives above it. */
export function createDrizzlePreferenceRecords(
  database: Database,
): PreferenceRecordStore {
  const table = genericPersonalPreferences;
  return {
    async create(row) {
      await database.insert(table).values(row);
    },
    async load(tenantId, id) {
      const [found] = await database
        .select()
        .from(table)
        .where(and(eq(table.tenantId, tenantId), eq(table.id, id)))
        .limit(1);
      return found ?? null;
    },
    async save(row) {
      await database
        .update(table)
        .set({
          content: row.content,
          provenance: row.provenance,
          reviewState: row.reviewState,
          enabled: row.enabled,
          deletedAt: row.deletedAt,
          syncedContentDigest: row.syncedContentDigest,
          syncedAt: row.syncedAt,
          effectiveFrom: row.effectiveFrom,
          effectiveUntil: row.effectiveUntil,
          supersededBy: row.supersededBy,
          supersededTimeUnknown: row.supersededTimeUnknown,
          correctedAt: row.correctedAt,
          updatedAt: row.updatedAt,
        })
        .where(and(eq(table.tenantId, row.tenantId), eq(table.id, row.id)));
    },
    async loadByDocumentIds(tenantId, principalId, documentIds) {
      if (!documentIds.length) return [];
      return database
        .select()
        .from(table)
        .where(
          and(
            eq(table.tenantId, tenantId),
            eq(table.principalId, principalId),
            inArray(table.hindsightDocumentId, [...documentIds]),
          ),
        );
    },
    async listLiving(tenantId, principalId, limit) {
      return database
        .select()
        .from(table)
        .where(
          and(
            eq(table.tenantId, tenantId),
            eq(table.principalId, principalId),
            isNull(table.deletedAt),
          ),
        )
        .orderBy(desc(table.updatedAt))
        .limit(limit);
    },
  };
}
