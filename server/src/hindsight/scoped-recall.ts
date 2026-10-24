/**
 * Hindsight 06 (#383): authorized recall of source-bound personal memories.
 *
 * A source-bound memory is a business fact the person confirmed out of a team conversation or
 * a connected source, and whose visibility STAYS bound to the scope that formed it — the
 * person's confirmation never lifts it into the general-preference bank (that is a different
 * seam, preference-recall.ts, over a different authority table, so team A's facts cannot reach
 * team B's Bots here even in principle). This module is the recall seam for that half of the
 * spec, and it inherits #382's division of labor whole: Hindsight ranks, OpenBot answers. Only
 * each bank's hit list of document ids is taken from the service; the content a Bot receives
 * is the confirmed original re-loaded from this principal's rows in this company.
 *
 * The bank set is not a property of the person; it is a property of the moment. A recall takes
 * a CURRENT authorization snapshot — an active membership in the ASKING workspace, enabled
 * connected sources, and the asking Bot's own standing — turns it into team/source/bot banks
 * through
 * `resolveScopedHindsightBankScope` (#381's derived-isolation seam; nothing client-supplied
 * can name a bank), recalls each bank under one short-lived assertion, and then re-reads the
 * authorization AFTER the remote has answered, before any hit becomes a Bot-visible fact. That
 * second read is the TOCTOU clause: a source disabled, a membership suspended, or a Bot's app
 * revoked between hit and load drops the hit the same as one revoked an hour ago. A revocation
 * landing before the recall shrinks the bank list itself — the service never sees the question.
 *
 * An administrator is not an exception: a trusted admin scope is still one principal, and the
 * rows this seam loads are pinned to (tenant, principal), so an admin asking about an
 * employee's memories gets the same answer any other non-owner gets — nothing. Tags are never
 * sent, and never consulted: the bank grant is the boundary (#381's validator enforces the
 * same on the service side).
 *
 * Sync follows #382's discipline: confirming retains into the row's restricted bank under a
 * stable document identity (an edit replaces the remote document in place); a retain failure
 * never fails the confirmation — the row awaits its sync, and the durable retry queue is #384
 * (this module accepts a work recorder so the queue can be attached without a route knowing
 * about it).
 *
 * Hindsight 10 (#387) adds the person's correction and forgetting entries on this half of the
 * spec: `editSourceBoundMemory` (an edit re-asserts into the restriction's bank, so the target
 * must still be authorized) and `forgetSourceBoundMemory` (tombstone + best-effort remote
 * delete; removal is never blocked by a lost authorization). The eligibility predicate, the
 * authorization snapshot and the view mapper are exported so the safe-degradation recall
 * (#385) and the answer-evidence seam (#387) reuse THIS module's rules instead of growing
 * looser copies.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { enterpriseWorkspaceMemberships } from "../db/schema/enterprise-tenancy";
import {
  hindsightMemoryGrants,
  sourceBoundMemories,
} from "../db/schema/hindsight-source-bound";
import type { PlatformScope } from "../enterprise/contracts";
import {
  backgroundTaskBankScope,
  botBankFor,
  type HindsightBankGrant,
  type HindsightBankScope,
  mintBankScopeAssertion,
  resolveHindsightBankScope,
  resolveScopedHindsightBankScope,
  sourceBankFor,
  teamBankFor,
} from "./bank-scope";
import type { HindsightBudgetGate } from "./budget-gate";
import { type HindsightPauseControls, usagePausedFor } from "./pause-controls";
import type { PreferenceRecallServiceConfig } from "./preference-recall";
import { type HindsightRecoveryGate, recallOpenFor } from "./restore-recovery";
import {
  type MemoryRevocationStatus,
  type PersonalMemoryRevocationRecorder,
  STOPPED_USING_SUMMARY,
} from "./revocation-ledger";
import { assertMemoryContentAdmissible } from "./sensitivity-gate";

/** The restriction that carves a memory's bank; exactly one target, spelled by the kind. */
export type SourceBoundRestriction =
  | { kind: "team"; workspaceId: string }
  | { kind: "source"; sourceId: string }
  | { kind: "bot"; agentId: string };

/** What a Bot receives: the confirmed original, its restriction, and nothing remote-derived. */
export type RecalledSourceBoundMemory = {
  /** The OpenBot record id — the only id this seam's contract carries. */
  id: string;
  content: string;
  provenance: string;
  /** Which scope's authorization still gates this fact: the forming team, source, or Bot. */
  restriction: SourceBoundRestriction;
  /** When the fact was formed — the evidence the person confirmed. */
  formedAt: Date;
};

/** The authority row, in full; internal to the module and its tests. */
export type SourceBoundRecordRow = {
  tenantId: string;
  id: string;
  principalId: string;
  restriction: "team" | "source" | "bot";
  workspaceId: string | null;
  sourceId: string | null;
  agentId: string | null;
  content: string;
  provenance: string;
  reviewState: "unreviewed" | "confirmed" | "edited";
  enabled: boolean;
  deletedAt: Date | null;
  formedAt: Date;
  hindsightDocumentId: string;
  syncedContentDigest: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The persistence port; all policy lives in the service above it. */
export interface SourceBoundRecordStore {
  create(row: SourceBoundRecordRow): Promise<void>;
  load(tenantId: string, id: string): Promise<SourceBoundRecordRow | null>;
  /** Full-row update by (tenantId, id); the id and document identity never change. */
  save(row: SourceBoundRecordRow): Promise<void>;
  /** Rows of THIS principal in THIS company holding these document ids. */
  loadByDocumentIds(
    tenantId: string,
    principalId: string,
    documentIds: readonly string[],
  ): Promise<SourceBoundRecordRow[]>;
}

/**
 * The live authorization facts a recall (and a confirm) must read from current server state.
 * Implementations answer from the tenancy tables and the grant registry — never from the
 * request — so a snapshot is always a fresh read, which is what makes the post-hit re-read a
 * real check rather than a cached one.
 */
export interface SourceBoundAuthorizationStore {
  /** Whether the principal's membership in this workspace is currently active. */
  workspaceMembershipActive(
    tenantId: string,
    principalId: string,
    workspaceId: string,
  ): Promise<boolean>;
  enabledSourceIds(
    tenantId: string,
    principalId: string,
  ): Promise<readonly string[]>;
  botAuthorized(
    tenantId: string,
    principalId: string,
    agentId: string,
  ): Promise<boolean>;
}

/** The durable sync-work recorder #384 attaches; structural, so the queue satisfies it. */
export interface SourceBoundWorkRecorder {
  record(input: {
    subjectType: "source_bound";
    tenantId: string;
    subjectId: string;
    principalId: string;
    contentDigest: string;
  }): Promise<void>;
}

export class SourceBoundRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceBoundRefusedError";
  }
}

export class SourceBoundNotFoundError extends Error {
  constructor() {
    super("This source-bound memory could not be found.");
    this.name = "SourceBoundNotFoundError";
  }
}

/** The Hindsight service could not be asked; the safe-degradation path (#385) catches this. */
export class SourceBoundRecallUnavailableError extends Error {
  constructor() {
    super(
      "The memory index is unreachable right now; source-bound memories are unchanged and will recall once it is back.",
    );
    this.name = "SourceBoundRecallUnavailableError";
  }
}

/** How long one minted assertion stays valid; fresh per request, so short is correct. */
const ASSERTION_TTL_MS = 60_000;
/** The pinned deployment is single-tenant on the service side; the segment is a constant. */
const HINDSIGHT_TENANT_SEGMENT = "default";
const CONTENT_MAX = 6000;
const PROVENANCE_MAX = 500;
const QUERY_MAX = 512;
const AGENT_ID_MAX = 128;
const TARGET_ID_MAX = 256;
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
 * The stable document identity of one source-bound row: deterministic over the row's own
 * (tenant, id), the same discipline bank ids and preference documents follow.
 */
export function sourceBoundDocumentIdFor(
  tenantId: string,
  recordId: string,
): string {
  return `hsb_${hash16("source-bound", `${tenantId}:${recordId}`)}`;
}

function plainString(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new SourceBoundRefusedError(
      `A source-bound memory needs ${field} of 1..${max} characters.`,
    );
  }
  return value;
}

/** Parse and shape-check a caller's restriction claim; the target is authorization-checked next. */
function parseRestriction(input: unknown): SourceBoundRestriction {
  if (typeof input !== "object" || input === null) {
    throw new SourceBoundRefusedError(
      "A source-bound memory needs a restriction of { kind, workspaceId | sourceId | agentId }.",
    );
  }
  const record = input as Record<string, unknown>;
  if (record.kind === "team") {
    return {
      kind: "team",
      workspaceId: plainString(
        record.workspaceId,
        "a workspace id",
        TARGET_ID_MAX,
      ),
    };
  }
  if (record.kind === "source") {
    return {
      kind: "source",
      sourceId: plainString(record.sourceId, "a source id", TARGET_ID_MAX),
    };
  }
  if (record.kind === "bot") {
    return {
      kind: "bot",
      agentId: plainString(record.agentId, "an agent id", TARGET_ID_MAX),
    };
  }
  throw new SourceBoundRefusedError(
    "A restriction kind must be team, source, or bot.",
  );
}

const restrictionOf = (row: SourceBoundRecordRow): SourceBoundRestriction =>
  row.restriction === "team"
    ? { kind: "team", workspaceId: row.workspaceId ?? "" }
    : row.restriction === "source"
      ? { kind: "source", sourceId: row.sourceId ?? "" }
      : { kind: "bot", agentId: row.agentId ?? "" };

/** The bank a row's restriction carves; the placement derivations stay in bank-scope.ts. */
export function bankGrantForRestriction(
  restriction: SourceBoundRestriction,
): HindsightBankGrant {
  return restriction.kind === "team"
    ? { id: teamBankFor(restriction.workspaceId), kind: "team" }
    : restriction.kind === "source"
      ? { id: sourceBankFor(restriction.sourceId), kind: "source" }
      : { id: botBankFor(restriction.agentId), kind: "bot" };
}

/**
 * Map a database row to the contract a Bot sees: no bank, no document id, no sync state.
 * Exported because the safe-degradation path (#385) and the evidence seam (#387) must answer
 * with the SAME view — a second mapper is where a looser copy would start.
 */
export const toRecalledSourceBoundView = (
  row: SourceBoundRecordRow,
): RecalledSourceBoundMemory => ({
  id: row.id,
  content: row.content,
  provenance: row.provenance,
  restriction: restrictionOf(row),
  formedAt: row.formedAt,
});

/**
 * A row a recall may still hand to a Bot: live, on, and confirmed or edited. Exported for the
 * same single-source reason as the view mapper above.
 */
export const sourceBoundRecallEligible = (row: SourceBoundRecordRow) =>
  row.deletedAt === null &&
  row.enabled &&
  (row.reviewState === "confirmed" || row.reviewState === "edited") &&
  row.content !== "";

/** One authorization snapshot, as the recall and confirm paths read it. */
export type AuthorizationSnapshot = {
  workspaceId: string;
  workspaceActive: boolean;
  sourceIds: readonly string[];
  agentId: string | undefined;
  agentAuthorized: boolean;
};

/**
 * Whether a row's restriction is still authorized under a snapshot (the load-time check). A
 * team row answers only the asking workspace's conversations, and only while membership there
 * is active — team A's facts cannot reach a team B recall even if the service hands the
 * document id over.
 */
export function stillAuthorized(
  row: SourceBoundRecordRow,
  snapshot: AuthorizationSnapshot,
): boolean {
  if (row.restriction === "team") {
    return snapshot.workspaceActive && row.workspaceId === snapshot.workspaceId;
  }
  if (row.restriction === "source") {
    return snapshot.sourceIds.includes(row.sourceId ?? "");
  }
  return (
    snapshot.agentId !== undefined &&
    snapshot.agentId === row.agentId &&
    snapshot.agentAuthorized
  );
}

/** Whether a claimed restriction is authorized for a CONFIRM (present authority, both sides). */
function restrictionAuthorized(
  restriction: SourceBoundRestriction,
  snapshot: AuthorizationSnapshot,
): boolean {
  return stillAuthorized(
    {
      restriction: restriction.kind,
      workspaceId: restriction.kind === "team" ? restriction.workspaceId : null,
      sourceId: restriction.kind === "source" ? restriction.sourceId : null,
      agentId: restriction.kind === "bot" ? restriction.agentId : null,
    } as SourceBoundRecordRow,
    snapshot,
  );
}

/**
 * Read one authorization snapshot live from current server state. Every caller reads it the
 * same way — the recall seam twice by design, the confirm path, the degradation path (#385)
 * and the evidence seam (#387) — so the snapshot shape stays the single policy fact.
 */
export async function readScopedAuthorization(
  authorizations: SourceBoundAuthorizationStore,
  tenantId: string,
  principalId: string,
  workspaceId: string,
  agentId: string | undefined,
): Promise<AuthorizationSnapshot> {
  const [workspaceActive, sourceIds] = await Promise.all([
    authorizations.workspaceMembershipActive(
      tenantId,
      principalId,
      workspaceId,
    ),
    authorizations.enabledSourceIds(tenantId, principalId),
  ]);
  const agentAuthorized =
    agentId === undefined
      ? false
      : await authorizations.botAuthorized(tenantId, principalId, agentId);
  return { workspaceId, workspaceActive, sourceIds, agentId, agentAuthorized };
}

/**
 * Whether a source-bound row is authorized NOW under one live snapshot read, including the
 * per-row check Bot-restricted rows need (the snapshot's agentId belongs to whoever is
 * asking, not to the row's own forming Bot). Team and source rows answer straight off the
 * snapshot. Exported so the evidence seam (#387) and the derived-judgment gates (#388)
 * enforce the SAME rule instead of growing copies of it.
 */
export async function sourceBoundAuthorizedNow(
  authorizations: SourceBoundAuthorizationStore,
  row: SourceBoundRecordRow,
  base: AuthorizationSnapshot,
): Promise<boolean> {
  if (row.restriction === "bot") {
    const snapshot: AuthorizationSnapshot = {
      ...base,
      agentId: row.agentId ?? undefined,
      agentAuthorized: await authorizations.botAuthorized(
        row.tenantId,
        row.principalId,
        row.agentId ?? "",
      ),
    };
    return stillAuthorized(row, snapshot);
  }
  return stillAuthorized(row, base);
}

export function createSourceBoundRecallService(
  records: SourceBoundRecordStore,
  authorizations: SourceBoundAuthorizationStore,
  config: PreferenceRecallServiceConfig,
  options: {
    now?: () => Date;
    work?: SourceBoundWorkRecorder;
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
     * The background-processing budget gate (#393, FIX-F23 / FR-2). The confirm/edit eager
     * retains are model-call paths exactly like the judgment review's, and they admit through
     * the same gate the sync queue's drains do: exhaustion skips the retain — the person's
     * confirmation stands and the work row keeps the retry — and an admitted retain settles
     * when the service answered (a refusal did the work) and releases when it was never
     * reached, the queue's discipline.
     */
    budget?: HindsightBudgetGate;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const doFetch =
    config.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));

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
   * Retain one row's confirmed content into its restricted bank; failure leaves the row
   * pending. `reached` says whether the service answered at all, so a budgeted caller can
   * settle the one outcome and release the other.
   */
  async function retain(
    grant: HindsightBankScope,
    bankId: string,
    row: SourceBoundRecordRow,
  ): Promise<{ synced: boolean; reached: boolean }> {
    try {
      const response = await hindsight(
        grant,
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bankId}/memories`,
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
   * The eager retain behind a confirm/edit, admitted through the budget gate when one is
   * wired (#393, FIX-F23 / FR-2 — the seam the final review caught bypassing it). An
   * exhausted budget does NOT fail the person's decision: the retain is skipped,
   * `remoteSynced` answers false and the work row recorded just above owns the retry — the
   * drain re-admits it under its own work key once the budget recovers, so an exhausted
   * decision charges nothing here. The admission key is stable per row and confirmed
   * content, the judgment review's `admittedRetain` discipline.
   */
  async function admittedRetain(
    identity: { tenantId: string; principalId: string },
    bank: HindsightBankGrant,
    row: SourceBoundRecordRow,
  ): Promise<boolean> {
    if (!options.budget) {
      return (
        await retain(backgroundTaskBankScope(identity, bank), bank.id, row)
      ).synced;
    }
    const admission = await options.budget.admitBackgroundWork({
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      workKey: `source-bound-eager:${row.id}:${digestOf(row.content)}`,
      units: 1,
    });
    if (!admission.ok) return false;
    const outcome = await retain(
      backgroundTaskBankScope(identity, bank),
      bank.id,
      row,
    );
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
  }

  /**
   * Best-effort remote delete of one document whose outcome is observable (#390): `attempted`
   * is false exactly when the service could not be reached; `confirmed` is true on 2xx or 404.
   * Never thrown — the authority row already stopped every use before this ran.
   */
  async function deleteRemoteDocument(
    identity: { tenantId: string; principalId: string },
    bank: HindsightBankGrant,
    documentId: string,
  ): Promise<{
    attempted: boolean;
    confirmed: boolean;
    error: string | null;
  }> {
    try {
      const response = await hindsight(
        backgroundTaskBankScope(identity, bank),
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bank.id}/documents/${encodeURIComponent(documentId)}`,
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

  /** Read the authorization snapshot live; the recall reads it twice by design. */
  async function readAuthorization(
    tenantId: string,
    principalId: string,
    workspaceId: string,
    agentId: string | undefined,
  ): Promise<AuthorizationSnapshot> {
    return readScopedAuthorization(
      authorizations,
      tenantId,
      principalId,
      workspaceId,
      agentId,
    );
  }

  return {
    /**
     * Confirm a source-bound memory. The restriction must be CURRENTLY authorized — the bank is
     * chosen by present authority, not by the claim — and the retain goes into that restriction's
     * bank, never the user bank: confirming a source-bound fact cannot make it a general
     * preference. A retain failure never fails the confirmation.
     */
    async confirmSourceBoundMemory(
      scope: PlatformScope,
      input: {
        content: unknown;
        provenance?: unknown;
        restriction: unknown;
        /** The person's explicit second confirmation for sensitive content (F-G1-4). */
        confirmSensitive?: unknown;
      },
    ): Promise<{ record: RecalledSourceBoundMemory; remoteSynced: boolean }> {
      const identity = resolveHindsightBankScope(scope);
      const content = plainString(input.content, "content", CONTENT_MAX);
      // The chain-side sensitivity gate (audit F-G1-4), before the restriction is even read:
      // a refused credential leaves no row, no work and no audit copy of the bytes.
      assertMemoryContentAdmissible(content, input.confirmSensitive);
      const provenance = plainString(
        input.provenance ?? "You",
        "provenance",
        PROVENANCE_MAX,
      );
      const restriction = parseRestriction(input.restriction);
      const snapshot = await readAuthorization(
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        restriction.kind === "bot" ? restriction.agentId : undefined,
      );
      if (!restrictionAuthorized(restriction, snapshot)) {
        throw new SourceBoundRefusedError(
          "This restriction is not currently authorized for you; the memory cannot be confirmed into it.",
        );
      }
      const bank = bankGrantForRestriction(restriction);
      // Authority first: the row exists before anything leaves for the service.
      const id = randomUUID();
      const row: SourceBoundRecordRow = {
        tenantId: identity.tenantId,
        id,
        principalId: identity.principalId,
        restriction: restriction.kind,
        workspaceId:
          restriction.kind === "team" ? restriction.workspaceId : null,
        sourceId: restriction.kind === "source" ? restriction.sourceId : null,
        agentId: restriction.kind === "bot" ? restriction.agentId : null,
        content,
        provenance,
        reviewState: "confirmed",
        enabled: true,
        deletedAt: null,
        formedAt: now(),
        hindsightDocumentId: sourceBoundDocumentIdFor(identity.tenantId, id),
        syncedContentDigest: null,
        syncedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      await records.create(row);
      if (options.work) {
        await options.work.record({
          subjectType: "source_bound",
          tenantId: row.tenantId,
          subjectId: row.id,
          principalId: row.principalId,
          contentDigest: digestOf(row.content),
        });
      }
      const remoteSynced = await admittedRetain(identity, bank, row);
      if (remoteSynced) await records.save(row);
      return { record: toRecalledSourceBoundView(row), remoteSynced };
    },

    /**
     * THE source-bound recall: snapshot one resolves the bank set, one assertion covers them all,
     * each bank is asked in turn, and only the merged hit list's document ids survive — then the
     * authorization is re-read and every hit must still pass it, the tombstone rules, and this
     * principal's own rows. An empty snapshot answers empty; nothing is ever guessed into a bank.
     */
    async recallSourceBoundMemories(
      scope: PlatformScope,
      input: { query: unknown; askingAgentId?: unknown },
    ): Promise<RecalledSourceBoundMemory[]> {
      const identity = resolveHindsightBankScope(scope);
      const query = plainString(input.query, "a query", QUERY_MAX).trim();
      let askingAgentId: string | undefined;
      if (input.askingAgentId !== undefined) {
        askingAgentId = plainString(
          input.askingAgentId,
          "an asking agent id",
          AGENT_ID_MAX,
        );
      }
      // Pause-usage (#392): checked before any authorization read or remote call, so the
      // degradation path never runs either; the records stay, only their use stops.
      if (await usagePausedFor(options.pause, scope)) return [];
      // Backup-restore gate (#391): a restore that has not been replayed keeps recall closed;
      // the empty answer precedes every read, so the degradation path never opens.
      if (!(await recallOpenFor(options.recovery))) return [];
      const first = await readAuthorization(
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        askingAgentId,
      );
      const grant = resolveScopedHindsightBankScope(scope, {
        workspaceActive: first.workspaceActive,
        sourceIds: first.sourceIds,
        agentId:
          askingAgentId !== undefined && first.agentAuthorized
            ? askingAgentId
            : undefined,
      });
      if (!grant.banks.length) return [];
      const ranked: string[] = [];
      const seen = new Set<string>();
      for (const bank of grant.banks) {
        let response: Response;
        try {
          response = await hindsight(
            grant,
            `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bank.id}/memories/recall`,
            { body: { query } },
          );
        } catch {
          throw new SourceBoundRecallUnavailableError();
        }
        // A bank the service has never seen is a scope that has confirmed nothing yet.
        if (response.status === 404) continue;
        if (!response.ok) throw new SourceBoundRecallUnavailableError();
        const payload = (await response.json().catch(() => null)) as {
          results?: { document_id?: unknown }[];
        } | null;
        for (const hit of payload?.results ?? []) {
          const documentId = hit?.document_id;
          if (typeof documentId !== "string" || seen.has(documentId)) continue;
          seen.add(documentId);
          ranked.push(documentId);
        }
      }
      if (!ranked.length) return [];
      const rows = await records.loadByDocumentIds(
        grant.tenantId,
        grant.principalId,
        ranked,
      );
      // The second read: what the authorization looks like NOW, after the remote answered —
      // a revocation that landed between hit and load is blocked exactly here.
      const current = await readAuthorization(
        grant.tenantId,
        grant.principalId,
        scope.workspaceId,
        askingAgentId,
      );
      const byDocument = new Map(
        rows.map((row) => [row.hindsightDocumentId, row]),
      );
      return ranked
        .flatMap((documentId) => {
          const row = byDocument.get(documentId);
          return row &&
            sourceBoundRecallEligible(row) &&
            stillAuthorized(row, current)
            ? [toRecalledSourceBoundView(row)]
            : [];
        })
        .slice(0, RECALL_LIMIT);
    },

    /**
     * Edit a source-bound memory's confirmed original (Hindsight 10 / #387's correction entry
     * for source-bound facts). The restriction target must STILL be authorized — the same rule
     * as a confirm, because the retain that follows re-asserts the content into that
     * restriction's bank, and a revoked team/source/Bot must not receive a fresh retain. The
     * document identity stays put, so the remote document is replaced in place; a retain
     * failure never fails the edit (the row awaits its sync, #384).
     */
    async editSourceBoundMemory(
      scope: PlatformScope,
      id: string,
      input: {
        content: unknown;
        /** The person's explicit second confirmation for sensitive content (F-G1-4). */
        confirmSensitive?: unknown;
      },
    ): Promise<{ record: RecalledSourceBoundMemory; remoteSynced: boolean }> {
      const identity = resolveHindsightBankScope(scope);
      const content = plainString(input.content, "content", CONTENT_MAX);
      // Same gate as the confirm: an edit cannot walk a credential into an authorized bank.
      assertMemoryContentAdmissible(content, input.confirmSensitive);
      const row = await records.load(identity.tenantId, id);
      if (
        !row ||
        row.principalId !== identity.principalId ||
        row.deletedAt !== null
      ) {
        throw new SourceBoundNotFoundError();
      }
      const restriction = restrictionOf(row);
      const snapshot = await readAuthorization(
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        restriction.kind === "bot" ? restriction.agentId : undefined,
      );
      if (!restrictionAuthorized(restriction, snapshot)) {
        throw new SourceBoundRefusedError(
          "This restriction is not currently authorized for you; the memory cannot be edited while it is out of scope.",
        );
      }
      row.content = content;
      row.reviewState = "edited";
      row.updatedAt = now();
      if (options.work) {
        await options.work.record({
          subjectType: "source_bound",
          tenantId: row.tenantId,
          subjectId: row.id,
          principalId: row.principalId,
          contentDigest: digestOf(row.content),
        });
      }
      const bank = bankGrantForRestriction(restriction);
      const remoteSynced = await admittedRetain(identity, bank, row);
      await records.save(row);
      return { record: toRecalledSourceBoundView(row), remoteSynced };
    },

    /**
     * Forget a source-bound memory (Hindsight 10 / #387's forgetting entry). Forgetting is
     * removal and is NEVER blocked by a lost restriction authorization — a revoked source's
     * copy is exactly the kind that must be able to disappear. The row is tombstoned the way
     * every authority table forgets (content cleared, disabled, deleted_at), so no later
     * recall — index hit or SQL degradation — can resurrect it; the remote document is deleted
     * best-effort under the row's own bank attribution, and a failed delete leaves a hit the
     * recall drops anyway (no current row, no Bot-visible content). Since #390 the answer is
     * the honest two-part status: stopped being used at `stoppedUsingAt` (the block lands
     * before any remote call is initiated), remote cleanup reported separately and never
     * claimed cleared.
     */
    async forgetSourceBoundMemory(
      scope: PlatformScope,
      id: string,
    ): Promise<MemoryRevocationStatus> {
      const identity = resolveHindsightBankScope(scope);
      const row = await records.load(identity.tenantId, id);
      if (
        !row ||
        row.principalId !== identity.principalId ||
        row.deletedAt !== null
      ) {
        throw new SourceBoundNotFoundError();
      }
      const stoppedUsingAt = now();
      const documentId = row.hindsightDocumentId;
      const bank = bankGrantForRestriction(restrictionOf(row));
      row.deletedAt = stoppedUsingAt;
      row.enabled = false;
      row.content = "";
      row.syncedContentDigest = null;
      row.syncedAt = null;
      row.updatedAt = stoppedUsingAt;
      await records.save(row);
      if (options.revocations) {
        await options.revocations.recordBlock({
          tenantId: identity.tenantId,
          principalId: identity.principalId,
          kind: "memory",
          subjectType: "source_bound",
          targetId: row.id,
          documentId,
          bankId: bank.id,
          bankKind: bank.kind,
          blockedAt: stoppedUsingAt,
        });
      }
      const deletion = await deleteRemoteDocument(identity, bank, documentId);
      if (options.revocations) {
        await options.revocations.noteDeletionOutcome({
          tenantId: identity.tenantId,
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
  };
}

export type SourceBoundRecallService = ReturnType<
  typeof createSourceBoundRecallService
>;

/** The SQL-backed record store: mechanical persistence only, all policy lives above it. */
export function createDrizzleSourceBoundRecords(
  database: Database,
): SourceBoundRecordStore {
  const table = sourceBoundMemories;
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
  };
}

/**
 * The SQL-backed authorization store: workspace membership is read live from the tenancy
 * table; sources and Bots from the grant registry. Every call is a fresh read — the recall
 * seam's TOCTOU clause depends on it.
 */
export function createDrizzleSourceBoundAuthorizations(
  database: Database,
): SourceBoundAuthorizationStore {
  return {
    async workspaceMembershipActive(tenantId, principalId, workspaceId) {
      const [found] = await database
        .select({ status: enterpriseWorkspaceMemberships.status })
        .from(enterpriseWorkspaceMemberships)
        .where(
          and(
            eq(enterpriseWorkspaceMemberships.tenantId, tenantId),
            eq(enterpriseWorkspaceMemberships.workspaceId, workspaceId),
            eq(enterpriseWorkspaceMemberships.principalId, principalId),
          ),
        )
        .limit(1);
      return found?.status === "active";
    },
    async enabledSourceIds(tenantId, principalId) {
      const rows = await database
        .select({ targetId: hindsightMemoryGrants.targetId })
        .from(hindsightMemoryGrants)
        .where(
          and(
            eq(hindsightMemoryGrants.tenantId, tenantId),
            eq(hindsightMemoryGrants.principalId, principalId),
            eq(hindsightMemoryGrants.kind, "source"),
            eq(hindsightMemoryGrants.enabled, true),
          ),
        );
      return rows.map((row) => row.targetId);
    },
    async botAuthorized(tenantId, principalId, agentId) {
      const [found] = await database
        .select({ enabled: hindsightMemoryGrants.enabled })
        .from(hindsightMemoryGrants)
        .where(
          and(
            eq(hindsightMemoryGrants.tenantId, tenantId),
            eq(hindsightMemoryGrants.principalId, principalId),
            eq(hindsightMemoryGrants.kind, "bot"),
            eq(hindsightMemoryGrants.targetId, agentId),
          ),
        )
        .limit(1);
      return found?.enabled === true;
    },
  };
}
