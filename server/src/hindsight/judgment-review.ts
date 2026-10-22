/**
 * Hindsight 12 (#389): the person's review of derived judgment candidates, and the confirmed
 * judgment's path into use.
 *
 * #388 proposed candidates and kept them structurally inert; this module is the two halves the
 * spec (parent #376) adds on top:
 *
 *   - THE REVIEW. The person confirms, adopts-with-edit, or rejects each candidate, and a
 *     candidate nobody decides on expires after 30 days (rule 1's candidate lifecycle, applied
 *     to judgment candidates). Every review act re-runs #388's four gates over the STORED
 *     evidence relation through the shared verifier — a confirm whose basis died names the gate
 *     and changes nothing. An edit touches the text and nothing else: the evidence relation,
 *     the provenance and the scope columns are never rewritten by it, so editing can neither
 *     swap the basis nor lift a restricted judgment into a wider one ("修改文本不改变依据来
 *     源或扩大授权"). A reject is terminal bookkeeping (review_state 'rejected'): nothing is
 *     retained, a document already retained is deleted best-effort, and — because every read
 *     path below keeps only confirmed-or-edited rows — a rejected judgment cannot enter Bot
 *     context even if the index still hands its hdj_ id back as a hit.
 *
 *   - THE USE. A confirmed (or edited) judgment is recallable exactly in the scope all of its
 *     evidence still lives in: retained into its own bank (the user bank for a general
 *     judgment, the restriction's bank otherwise) under the hdj_ identity #388 assigned, and
 *     recalled from the banks the asking context is currently authorized for. Hindsight ranks,
 *     OpenBot answers — the hit list's document ids are re-resolved against this principal's
 *     rows, and each row must STILL pass the review gate, its own scope's current
 *     authorization (re-read after the remote answered, #383's TOCTOU discipline), and the four
 *     evidence gates one more time. That last re-run is rule 4's sentence made code: a
 *     judgment whose basis is later forgotten, de-authorized or deleted stops being used
 *     immediately, confirmation notwithstanding — and returns by itself if the authority
 *     returns, because nothing was cached at confirm time.
 *
 * The evidence chain is the third face of the same rule: `inspectJudgmentEvidence` expands a
 * judgment's record id into the judgment plus its complete basis, rendered by the same
 * function the candidate surface uses, one level per request (a nested confirmed judgment
 * appears with its own id — expanding THAT is the next request, so the chain is followable
 * but never infinitely rendered). The answer-evidence seam (#387) dispatches judgment ids
 * here, and the person can edit or forget the judgment from the chain.
 *
 * Sync follows the two confirm seams' discipline: the review decision is durable first, the
 * retain is attempted eagerly, and a retain failure never fails the decision — the work row
 * (#384, subject_type 'derived_judgment') holds the intent and the queue drains it later, at
 * task time re-loading the row and re-reading its scope's authorization. The model never
 * announces a judgment learned: "indexed" is provable only by the row's retained digest
 * matching its current content, exactly as #384 words it.
 */

import { createHash } from "node:crypto";
import type { PlatformScope } from "../enterprise/contracts";
import {
  backgroundTaskBankScope,
  botBankFor,
  companySchemaFor,
  type HindsightBankGrant,
  type HindsightBankScope,
  mintBankScopeAssertion,
  resolveHindsightBankScope,
  resolveScopedHindsightBankScope,
  sourceBankFor,
  teamBankFor,
  userBankFor,
} from "./bank-scope";
import {
  createDerivedJudgmentEvidenceVerifier,
  DerivedJudgmentRefusedError,
  type DerivedJudgmentRow,
  type DerivedJudgmentStore,
  derivedJudgmentEligible,
  JUDGMENT_CONTENT_MAX,
  type JudgmentEvidenceView,
  type JudgmentScope,
  judgmentScopeOf,
  type ResolvedEvidence,
  refusalOf,
  renderEvidenceView,
} from "./derived-judgments";
import { type HindsightPauseControls, usagePausedFor } from "./pause-controls";
import type {
  PreferenceRecallServiceConfig,
  PreferenceRecordStore,
} from "./preference-recall";
import { type HindsightRecoveryGate, recallOpenFor } from "./restore-recovery";
import {
  type MemoryRevocationStatus,
  type PersonalMemoryRevocationRecorder,
  STOPPED_USING_SUMMARY,
} from "./revocation-ledger";
import {
  type AuthorizationSnapshot,
  readScopedAuthorization,
  type SourceBoundAuthorizationStore,
  type SourceBoundRecordStore,
} from "./scoped-recall";
import {
  type MemoryRevocationStatus,
  type PersonalMemoryRevocationRecorder,
  STOPPED_USING_SUMMARY,
} from "./revocation-ledger";

/** The durable sync-work recorder #384 attaches; structural, so the queue satisfies it. */
export interface JudgmentWorkRecorder {
  record(input: {
    subjectType: "derived_judgment";
    tenantId: string;
    subjectId: string;
    principalId: string;
    contentDigest: string;
  }): Promise<void>;
}

/**
 * A judgment the person adopted, as the review surface and the evidence chain see it: the
 * current text, its one scope, and the complete basis in lead order.
 */
export type ReviewedDerivedJudgment = {
  /** The OpenBot record id — the only id this contract carries. */
  id: string;
  /** The adopted judgment text (the edited text, when the person edited). */
  content: string;
  provenance: string;
  /** The single scope all evidence shares; the judgment inherits its restriction. */
  scope: JudgmentScope;
  reviewState: "confirmed" | "edited";
  /** When the person last stood behind this text (the review act's evidence). */
  reviewedAt: Date;
  /** The complete basis, in lead order — the same rendering the candidate listing uses. */
  evidence: JudgmentEvidenceView[];
};

/** What a Bot receives from a recall: the adopted judgment plus the citations to expand. */
export type RecalledDerivedJudgment = {
  id: string;
  content: string;
  provenance: string;
  scope: JudgmentScope;
  reviewState: "confirmed" | "edited";
  reviewedAt: Date;
  /**
   * The basis citations, in lead order: record ids the answer may hand the evidence seam
   * (#387) to expand the chain behind this judgment.
   */
  evidence: {
    id: string;
    kind: "preference" | "source_bound" | "derived_judgment";
  }[];
};

/**
 * One basis entry of an expanded judgment chain. A nested confirmed judgment carries its own
 * id but not its own basis — expanding THAT is a separate inspect, so the chain is followable
 * one level at a time and never infinitely rendered.
 */
export type JudgmentBasisEntry =
  | Extract<JudgmentEvidenceView, { kind: "preference" }>
  | Extract<JudgmentEvidenceView, { kind: "source_bound" }>
  | {
      kind: "derived_judgment";
      id: string;
      content: string;
      provenance: string;
      scope: JudgmentScope;
      reviewState: "confirmed" | "edited";
      reviewedAt: Date;
    };

/** The evidence-chain expansion of one judgment: available in full, or indistinguishably gone. */
export type DerivedJudgmentInspection =
  | {
      state: "available";
      kind: "derived_judgment";
      id: string;
      content: string;
      provenance: string;
      scope: JudgmentScope;
      reviewState: "confirmed" | "edited";
      reviewedAt: Date;
      /** The complete basis, one level deep. */
      evidence: JudgmentBasisEntry[];
      /** What the person may launch from this entry (the spec's correction and forgetting). */
      actions: ("edit" | "forget")[];
    }
  | { state: "unavailable"; id: string };

export class DerivedJudgmentNotFoundError extends Error {
  constructor() {
    super("This derived judgment could not be found.");
    this.name = "DerivedJudgmentNotFoundError";
  }
}

/** A lifecycle refusal: the decision does not apply to a judgment in this review state. */
export class DerivedJudgmentReviewRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivedJudgmentReviewRefusedError";
  }
}

/** The Hindsight service could not be asked; mirrors the two recall seams' wording. */
export class DerivedJudgmentRecallUnavailableError extends Error {
  constructor() {
    super(
      "The memory index is unreachable right now; confirmed judgments are unchanged and will recall once it is back.",
    );
    this.name = "DerivedJudgmentRecallUnavailableError";
  }
}

/** How long one minted assertion stays valid; fresh per request, so short is correct. */
const ASSERTION_TTL_MS = 60_000;
/** The pinned deployment is single-tenant on the service side; the segment is a constant. */
const HINDSIGHT_TENANT_SEGMENT = "default";
const QUERY_MAX = 512;
const AGENT_ID_MAX = 128;
/** Bot-context economy: recall answers at most as many judgments as the other seams do. */
const RECALL_LIMIT = 20;
/** The spec's candidate rule: unhandled proposals expire after thirty days. */
const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

function plainString(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw new DerivedJudgmentRefusedError(
      "shape",
      `A derived judgment needs ${field} of 1..${max} characters.`,
    );
  }
  return value;
}

/**
 * The bank a judgment row's own scope carves (module-level, for raw rows): the user bank for
 * a general judgment, the restriction's bank otherwise. Exported so the revocation flow
 * (#390), which blocks judgment rows by direct update, derives each blocked document's bank
 * exactly the way this seam's retains and deletes do.
 */
export function judgmentBankGrantFor(row: {
  principalId: string;
  scopeKind: "general" | "team" | "source" | "bot";
  workspaceId: string | null;
  sourceId: string | null;
  agentId: string | null;
}): HindsightBankGrant {
  if (row.scopeKind === "general") {
    return { id: userBankFor(row.principalId), kind: "user" };
  }
  if (row.scopeKind === "team") {
    return { id: teamBankFor(row.workspaceId ?? ""), kind: "team" };
  }
  if (row.scopeKind === "source") {
    return { id: sourceBankFor(row.sourceId ?? ""), kind: "source" };
  }
  return { id: botBankFor(row.agentId ?? ""), kind: "bot" };
}

export function createDerivedJudgmentReviewService(
  preferences: PreferenceRecordStore,
  sourceBound: SourceBoundRecordStore,
  judgments: DerivedJudgmentStore,
  authorizations: SourceBoundAuthorizationStore,
  config: PreferenceRecallServiceConfig,
  options: {
    now?: () => Date;
    work?: JudgmentWorkRecorder;
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
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const doFetch =
    config.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const verifier = createDerivedJudgmentEvidenceVerifier(
    preferences,
    sourceBound,
    judgments,
    authorizations,
  );

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

  /** The bank a judgment row's own scope carves; the derivation lives in judgmentBankGrantFor. */
  function bankGrantFor(row: DerivedJudgmentRow): HindsightBankGrant {
    return judgmentBankGrantFor(row);
  }

  /**
   * Retain one row's adopted content into its own bank under its hdj_ identity; `replace`
   * keeps the retain idempotent per document, so an edit replaces in place. A non-2xx or an
   * unreachable service is reported, never thrown — the review decision stands and the work
   * row awaits the queue (#384).
   */
  async function retain(
    identity: { tenantId: string; principalId: string },
    row: DerivedJudgmentRow,
  ): Promise<boolean> {
    const bank = bankGrantFor(row);
    try {
      const response = await hindsight(
        backgroundTaskBankScope(identity, bank),
        `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bank.id}/memories`,
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
      if (!response.ok) return false;
      row.syncedContentDigest = digestOf(row.content);
      row.syncedAt = now();
      return true;
    } catch {
      return false;
    }
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

  /** Load one judgment of THIS principal in THIS company; foreign or gone answers null. */
  async function loadOwned(
    scope: PlatformScope,
    id: string,
  ): Promise<DerivedJudgmentRow | null> {
    const identity = resolveHindsightBankScope(scope);
    const row = await judgments.load(identity.tenantId, id);
    if (!row || row.principalId !== identity.principalId) return null;
    return row;
  }

  /** One live authorization snapshot for the asking scope. */
  async function snapshotFor(
    scope: PlatformScope,
  ): Promise<AuthorizationSnapshot> {
    const identity = resolveHindsightBankScope(scope);
    return readScopedAuthorization(
      authorizations,
      identity.tenantId,
      identity.principalId,
      scope.workspaceId,
      undefined,
    );
  }

  /**
   * Whether the judgment's OWN scope is authorized for this ask under a live snapshot — the
   * judgment-side twin of #383's stillAuthorized: a team judgment answers only the asking
   * workspace, a source judgment only while the source is enabled, a Bot judgment only for the
   * authorized Bot asking (per-row, because the snapshot's agent belongs to whoever is asking).
   */
  async function judgmentScopeAuthorizedNow(
    row: DerivedJudgmentRow,
    base: AuthorizationSnapshot,
  ): Promise<boolean> {
    if (row.scopeKind === "general") return true;
    if (row.scopeKind === "team") {
      return base.workspaceActive && row.workspaceId === base.workspaceId;
    }
    if (row.scopeKind === "source") {
      return base.sourceIds.includes(row.sourceId ?? "");
    }
    const agentAuthorized = await authorizations.botAuthorized(
      row.tenantId,
      row.principalId,
      row.agentId ?? "",
    );
    return (
      base.agentId !== undefined &&
      base.agentId === row.agentId &&
      agentAuthorized
    );
  }

  function reviewedView(
    row: DerivedJudgmentRow,
    evidence: readonly ResolvedEvidence[],
  ): ReviewedDerivedJudgment {
    return {
      id: row.id,
      content: row.content,
      provenance: row.provenance,
      scope: judgmentScopeOf(row),
      reviewState: row.reviewState as "confirmed" | "edited",
      reviewedAt: row.reviewedAt ?? row.updatedAt,
      evidence: evidence.map(renderEvidenceView),
    };
  }

  /** One basis entry of the chain; nested judgments stop one level deep, by type. */
  function basisEntryOf(evidence: ResolvedEvidence): JudgmentBasisEntry {
    if (evidence.kind === "derived_judgment") {
      return {
        kind: "derived_judgment",
        id: evidence.row.id,
        content: evidence.row.content,
        provenance: evidence.row.provenance,
        scope: judgmentScopeOf(evidence.row),
        reviewState: evidence.row.reviewState as "confirmed" | "edited",
        reviewedAt: evidence.row.reviewedAt ?? evidence.row.updatedAt,
      };
    }
    // The renderer is kind-preserving, so a non-judgment basis renders to its own variant.
    return renderEvidenceView(evidence) as JudgmentBasisEntry;
  }

  return {
    /**
     * Confirm a candidate: the person's explicit adoption. The four gates re-run over the
     * stored relation first — a confirm whose basis no longer stands is refused WITH its
     * reason and changes nothing. The decision is durable before anything leaves for the
     * service; the retain goes to the judgment's own bank, and a retain failure never fails
     * the confirmation (the queue owns the retry).
     */
    async confirmDerivedJudgment(
      scope: PlatformScope,
      id: string,
    ): Promise<{ judgment: ReviewedDerivedJudgment; remoteSynced: boolean }> {
      const identity = resolveHindsightBankScope(scope);
      const row = await loadOwned(scope, id);
      if (!row || row.deletedAt !== null)
        throw new DerivedJudgmentNotFoundError();
      if (row.reviewState !== "unreviewed") {
        throw new DerivedJudgmentReviewRefusedError(
          `This judgment was already ${row.reviewState}; only an unreviewed candidate can be confirmed.`,
        );
      }
      const snapshot = await snapshotFor(scope);
      const verified = await verifier.verifyStoredEvidence(
        identity.tenantId,
        identity.principalId,
        row,
        snapshot,
      );
      if (!verified.ok) {
        throw refusalOf(
          { ...verified, position: 0 },
          "the judgment cannot be confirmed",
        );
      }
      row.reviewState = "confirmed";
      row.reviewedAt = now();
      row.updatedAt = now();
      await judgments.save(row);
      if (options.work) {
        await options.work.record({
          subjectType: "derived_judgment",
          tenantId: row.tenantId,
          subjectId: row.id,
          principalId: row.principalId,
          contentDigest: digestOf(row.content),
        });
      }
      const remoteSynced = await retain(identity, row);
      if (remoteSynced) await judgments.save(row);
      return { judgment: reviewedView(row, verified.evidence), remoteSynced };
    },

    /**
     * Edit a judgment's text. On an unreviewed candidate this IS the adoption (the person
     * adopts with changes); on an adopted judgment it re-asserts the text. The edit re-runs the
     * four gates — a judgment whose basis died cannot be kept alive by editing it — and mutates
     * the text alone: the evidence relation, provenance and scope columns are untouched, so an
     * edit can neither swap the basis nor widen the scope, and the retain replaces the indexed
     * document in place under the same hdj_ identity.
     */
    async editDerivedJudgment(
      scope: PlatformScope,
      id: string,
      input: { content: unknown },
    ): Promise<{ judgment: ReviewedDerivedJudgment; remoteSynced: boolean }> {
      const identity = resolveHindsightBankScope(scope);
      const content = plainString(
        input.content,
        "a judgment",
        JUDGMENT_CONTENT_MAX,
      );
      const row = await loadOwned(scope, id);
      if (!row || row.deletedAt !== null)
        throw new DerivedJudgmentNotFoundError();
      if (row.reviewState === "rejected") {
        throw new DerivedJudgmentReviewRefusedError(
          "This judgment was rejected; a rejected judgment is final and cannot be edited back into use.",
        );
      }
      if (row.reviewState === "expired") {
        throw new DerivedJudgmentReviewRefusedError(
          "This candidate expired unreviewed; a fresh proposal must be derived again.",
        );
      }
      const snapshot = await snapshotFor(scope);
      const verified = await verifier.verifyStoredEvidence(
        identity.tenantId,
        identity.principalId,
        row,
        snapshot,
      );
      if (!verified.ok) {
        throw refusalOf(
          { ...verified, position: 0 },
          "the judgment cannot be adopted with this edit",
        );
      }
      row.content = content;
      row.reviewState = "edited";
      row.reviewedAt = now();
      row.updatedAt = now();
      await judgments.save(row);
      if (options.work) {
        await options.work.record({
          subjectType: "derived_judgment",
          tenantId: row.tenantId,
          subjectId: row.id,
          principalId: row.principalId,
          contentDigest: digestOf(row.content),
        });
      }
      const remoteSynced = await retain(identity, row);
      if (remoteSynced) await judgments.save(row);
      return { judgment: reviewedView(row, verified.evidence), remoteSynced };
    },

    /**
     * Reject a judgment: terminal. Nothing was retained for an unreviewed candidate; a
     * document already retained is deleted best-effort, and the row's own state stops every
     * read path regardless of what the index still holds. Rejecting twice is the same decision.
     */
    async rejectDerivedJudgment(
      scope: PlatformScope,
      id: string,
    ): Promise<{
      id: string;
      reviewState: "rejected";
      reviewedAt: Date;
    }> {
      const identity = resolveHindsightBankScope(scope);
      const row = await loadOwned(scope, id);
      if (!row || row.deletedAt !== null)
        throw new DerivedJudgmentNotFoundError();
      if (row.reviewState === "expired") {
        throw new DerivedJudgmentReviewRefusedError(
          "This candidate expired unreviewed; it is already closed.",
        );
      }
      if (row.reviewState === "rejected") {
        return {
          id: row.id,
          reviewState: "rejected",
          reviewedAt: row.reviewedAt ?? row.updatedAt,
        };
      }
      const wasSynced = row.syncedContentDigest !== null;
      row.reviewState = "rejected";
      row.reviewedAt = now();
      row.updatedAt = now();
      row.syncedContentDigest = null;
      row.syncedAt = null;
      await judgments.save(row);
      if (wasSynced) {
        await deleteRemoteDocument(
          identity,
          bankGrantFor(row),
          row.hindsightDocumentId,
        );
      }
      return {
        id: row.id,
        reviewState: "rejected",
        reviewedAt: row.reviewedAt,
      };
    },

    /**
     * Forget a judgment: the evidence chain's removal entry. Tombstoned the way every
     * authority table forgets (content cleared, disabled, deleted_at), so no later recall —
     * index hit or SQL read — can resurrect it, and the remote document is deleted
     * best-effort. Forgetting is never blocked by a lost scope authorization or by the review
     * state: removal must always be possible. Since #390 the answer is the honest two-part
     * status — stopped being used at `stoppedUsingAt` (the block lands before any remote
     * call), remote cleanup reported separately and never claimed cleared.
     */
    async forgetDerivedJudgment(
      scope: PlatformScope,
      id: string,
    ): Promise<MemoryRevocationStatus> {
      const identity = resolveHindsightBankScope(scope);
      const row = await loadOwned(scope, id);
      if (!row || row.deletedAt !== null)
        throw new DerivedJudgmentNotFoundError();
      const stoppedUsingAt = now();
      const documentId = row.hindsightDocumentId;
      const bank = bankGrantFor(row);
      row.deletedAt = stoppedUsingAt;
      row.enabled = false;
      row.content = "";
      row.syncedContentDigest = null;
      row.syncedAt = null;
      row.updatedAt = stoppedUsingAt;
      await judgments.save(row);
      if (options.revocations) {
        await options.revocations.recordBlock({
          tenantId: identity.tenantId,
          principalId: identity.principalId,
          kind: "memory",
          subjectType: "derived_judgment",
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

    /**
     * The expiry sweep: every unreviewed, living candidate older than the spec's thirty days
     * becomes 'expired'. Called by the background scheduler; owns no scope on purpose. The
     * partial lead index keeps expired rows out of the fold, so a replayed lead after expiry
     * produces a FRESH candidate for the person to review.
     */
    async expireStaleDerivedJudgmentCandidates(): Promise<{
      expired: number;
      cutoff: Date;
    }> {
      const cutoff = new Date(now().getTime() - CANDIDATE_TTL_MS);
      const expired = await judgments.expireUnreviewedBefore(cutoff);
      return { expired, cutoff };
    },

    /**
     * THE judgment recall: Hindsight ranks, OpenBot answers. The banks asked are the ones the
     * asking context is CURRENTLY authorized for — the person's own user bank, plus the
     * scoped banks #383's resolver names — and only this principal's rows behind the hit
     * document ids are ever read. Each row must still be adopted (confirmed/edited), still
     * inside its own scope's CURRENT authorization, and still stand on its whole basis (the
     * four gates, re-run after the remote answered); anything else is dropped before a Bot
     * sees a byte, which is what "停止使用" tests.
     */
    async recallDerivedJudgments(
      scope: PlatformScope,
      input: { query: unknown; askingAgentId?: unknown },
    ): Promise<RecalledDerivedJudgment[]> {
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
      // Pause-usage (#392): checked before any bank is resolved or asked, so the degradation
      // path never runs either; the adopted judgments stay, only their use stops.
      if (await usagePausedFor(options.pause, scope)) return [];
      // Backup-restore gate (#391): a restore that has not been replayed keeps recall closed;
      // the empty answer precedes every bank resolution, so the degradation path never opens.
      if (!(await recallOpenFor(options.recovery))) return [];
      const first = await readScopedAuthorization(
        authorizations,
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        askingAgentId,
      );
      const scoped = resolveScopedHindsightBankScope(scope, {
        workspaceActive: first.workspaceActive,
        sourceIds: first.sourceIds,
        agentId:
          askingAgentId !== undefined && first.agentAuthorized
            ? askingAgentId
            : undefined,
      });
      const banks: HindsightBankGrant[] = [
        { id: userBankFor(identity.principalId), kind: "user" },
        ...scoped.banks,
      ];
      const ranked: string[] = [];
      const seen = new Set<string>();
      for (const bank of banks) {
        let response: Response;
        try {
          response = await hindsight(
            {
              schema: companySchemaFor(identity.tenantId),
              banks: [bank],
              tenantId: identity.tenantId,
              principalId: identity.principalId,
            },
            `/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${bank.id}/memories/recall`,
            { body: { query } },
          );
        } catch {
          throw new DerivedJudgmentRecallUnavailableError();
        }
        // A bank the service has never seen is a scope that has confirmed nothing yet.
        if (response.status === 404) continue;
        if (!response.ok) throw new DerivedJudgmentRecallUnavailableError();
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
      const rows = await judgments.loadByDocumentIds(
        identity.tenantId,
        identity.principalId,
        ranked,
      );
      // The second read: what the authorization looks like NOW, after the remote answered.
      const second = await readScopedAuthorization(
        authorizations,
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        askingAgentId,
      );
      const byDocument = new Map(
        rows.map((row) => [row.hindsightDocumentId, row]),
      );
      const recalled: RecalledDerivedJudgment[] = [];
      for (const documentId of ranked) {
        if (recalled.length >= RECALL_LIMIT) break;
        const row = byDocument.get(documentId);
        if (!row || !derivedJudgmentEligible(row)) continue;
        if (!(await judgmentScopeAuthorizedNow(row, second))) continue;
        const verified = await verifier.verifyStoredEvidence(
          identity.tenantId,
          identity.principalId,
          row,
          second,
        );
        if (!verified.ok) continue;
        recalled.push({
          id: row.id,
          content: row.content,
          provenance: row.provenance,
          scope: judgmentScopeOf(row),
          reviewState: row.reviewState as "confirmed" | "edited",
          reviewedAt: row.reviewedAt ?? row.updatedAt,
          evidence: verified.evidence.map((basis) => ({
            id: basis.row.id,
            kind: basis.kind,
          })),
        });
      }
      return recalled;
    },

    /**
     * Expand one judgment's record id into its evidence-chain entry: the adopted text, its
     * scope, when the person adopted it, and the complete basis one level deep. Availability is
     * re-decided NOW — the row must still be adopted, its scope still authorized, and its whole
     * basis still stand — and everything else answers the same { state: "unavailable" } the
     * evidence seam (#387) answers missing, foreign or revoked bases with: no content, and
     * deliberately no reason.
     */
    async inspectJudgmentEvidence(
      scope: PlatformScope,
      id: string,
    ): Promise<DerivedJudgmentInspection> {
      const identity = resolveHindsightBankScope(scope);
      const row = await loadOwned(scope, id);
      if (!row || !derivedJudgmentEligible(row)) {
        return { state: "unavailable", id };
      }
      const snapshot = await snapshotFor(scope);
      if (!(await judgmentScopeAuthorizedNow(row, snapshot))) {
        return { state: "unavailable", id };
      }
      const verified = await verifier.verifyStoredEvidence(
        identity.tenantId,
        identity.principalId,
        row,
        snapshot,
      );
      if (!verified.ok) return { state: "unavailable", id };
      return {
        state: "available",
        kind: "derived_judgment",
        id: row.id,
        content: row.content,
        provenance: row.provenance,
        scope: judgmentScopeOf(row),
        reviewState: row.reviewState as "confirmed" | "edited",
        reviewedAt: row.reviewedAt ?? row.updatedAt,
        evidence: verified.evidence.map(basisEntryOf),
        actions: ["edit", "forget"],
      };
    },

    /**
     * Whether id names a live judgment of THIS principal (any review state) — the owner probe
     * the evidence seam (#387) dispatches on. Never answers true for another person's id.
     */
    async ownsJudgment(scope: PlatformScope, id: string): Promise<boolean> {
      const row = await loadOwned(scope, id);
      return row !== null && row.deletedAt === null;
    },
  };
}

export type DerivedJudgmentReviewService = ReturnType<
  typeof createDerivedJudgmentReviewService
>;
