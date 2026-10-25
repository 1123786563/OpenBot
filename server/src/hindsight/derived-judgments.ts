/**
 * Hindsight 11 (#388): derived judgment candidates within one authorized source.
 *
 * A derived judgment is what the spec calls a persistent conclusion synthesized out of
 * MULTIPLE confirmed experiences — and the domain's first rule (CONTEXT.md「Derived Memory」,
 * ADR 0005) is that confirmed evidence does not make the judgment itself confirmed. This
 * module produces CANDIDATES only: a proposal arrives as a lead (the judgment text plus the
 * document ids of the experiences it claims to synthesize — Hindsight's observations are
 * exactly such leads, and nothing they say is trusted on arrival), and OpenBot verifies the
 * full evidence relation before the candidate exists at all. The person's confirm/edit/reject
 * is #389; nothing here reviews anything.
 *
 * The verification is four gates, in a fixed order, every time a candidate is proposed OR
 * shown (each rejection reason is observable, which is what the ticket's negative paths
 * test):
 *
 *   1. MISSING — every cited document id must resolve to a live authority row of THIS
 *      principal in THIS company. Another person's fact, an orphaned id, a document the
 *      service hallucinated: same answer, no judgment.
 *   2. CROSS-SOURCE — all evidence must share one scope: the general personal memory, or
 *      exactly one authorized source (the forming team, the connected source, or the Bot).
 *      First version does not synthesize across sources, so a general preference mixed with
 *      a team fact — or team A with team B — refuses here. Team evidence is additionally
 *      bound to the asking workspace by the same rule #383's recall enforces.
 *   3. UNCONFIRMED — each resolved row must be a reviewed, living fact: confirmed or edited,
 *      enabled, not forgotten. An unreviewed candidate of ANY kind — including another
 *      derived judgment — cannot support a judgment; that is the "next level" prohibition.
 *   4. UNAUTHORIZED — source-bound evidence must still pass a CURRENT authorization read
 *      (source enabled, membership active, the forming Bot's app held). A judgment whose
 *      evidence lost its authority is not proposed; one already proposed disappears from the
 *      candidate listing until the authority returns.
 *
 * Unreviewed judgments are structurally unrecallable, by construction rather than by check:
 * this module holds no Hindsight service configuration and makes no remote calls — a
 * candidate is never retained anywhere — and the recall seams (#382/#383) plus the
 * degradation path (#385) read only their own authority tables, so the candidate's hdj_
 * document id maps to no row they will ever load. The judgment-recall seam #389 adds reads
 * THIS table but keeps only confirmed-or-edited rows, so an unreviewed candidate still maps
 * to nothing any Bot can see. The document identity is still assigned at creation, because a
 * confirm (#389) drains through the sync queue (#384) under an identity that must not depend
 * on the review outcome.
 *
 * Replayed leads fold at the storage layer: a partial unique index allows one unreviewed
 * candidate per (scope, judgment text, evidence set), so proposing the same lead twice
 * returns the existing candidate instead of stacking a copy for the person to dismiss.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  derivedJudgmentCandidates,
  derivedJudgmentEvidence,
} from "../db/schema/hindsight-judgments";
import type { PlatformScope } from "../enterprise/contracts";
import { resolveHindsightBankScope } from "./bank-scope";
import { type HindsightPauseControls, learningPausedFor } from "./pause-controls";
import {
  type PreferenceAuthorityRow,
  type PreferenceRecordStore,
  preferenceRecallEligible,
} from "./preference-recall";
import {
  type AuthorizationSnapshot,
  readScopedAuthorization,
  type SourceBoundAuthorizationStore,
  type SourceBoundRecordRow,
  type SourceBoundRecordStore,
  sourceBoundAuthorizedNow,
  sourceBoundRecallEligible,
} from "./scoped-recall";
import { isUniqueViolation } from "./sync-queue";

/**
 * The one scope a judgment and all of its evidence live in: the general personal memory, or
 * exactly one authorized source. Mirrors the restriction vocabulary of #383 with `general`
 * added for preference-only evidence.
 */
export type JudgmentScope =
  | { kind: "general" }
  | { kind: "team"; workspaceId: string }
  | { kind: "source"; sourceId: string }
  | { kind: "bot"; agentId: string };

/** The authority row, in full; internal to the module and its tests. */
export type DerivedJudgmentRow = {
  tenantId: string;
  id: string;
  principalId: string;
  scopeKind: "general" | "team" | "source" | "bot";
  workspaceId: string | null;
  sourceId: string | null;
  agentId: string | null;
  content: string;
  provenance: string;
  reviewState: "unreviewed" | "confirmed" | "edited" | "rejected" | "expired";
  enabled: boolean;
  deletedAt: Date | null;
  /** When the person decided (#389), or the expiry sweep decided for them; null while waiting. */
  reviewedAt: Date | null;
  proposalDigest: string;
  hindsightDocumentId: string;
  syncedContentDigest: string | null;
  syncedAt: Date | null;
  proposedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** One edge of the complete evidence relation: a typed reference to an authority row. */
export type DerivedJudgmentEvidenceRow = {
  tenantId: string;
  judgmentId: string;
  position: number;
  evidenceType: "preference" | "source_bound" | "derived_judgment";
  evidenceId: string;
};

/** The persistence port; all policy lives in the service above it. */
export interface DerivedJudgmentStore {
  /** Candidate and its evidence relation land atomically, or not at all. */
  create(
    row: DerivedJudgmentRow,
    evidence: readonly DerivedJudgmentEvidenceRow[],
  ): Promise<void>;
  /** Full-row update by (tenantId, id); the id, document identity and evidence relation never change. */
  save(row: DerivedJudgmentRow): Promise<void>;
  /**
   * The expiry sweep (#389): every still-unreviewed, living candidate proposed strictly before
   * the cutoff becomes 'expired' with `reviewedAt` set to the sweep's decision time. Returns
   * how many rows expired; the sweep is global because a background task owns no one scope.
   */
  expireUnreviewedBefore(cutoff: Date): Promise<number>;
  load(tenantId: string, id: string): Promise<DerivedJudgmentRow | null>;
  /** Rows of THIS principal in THIS company holding these document ids. */
  loadByDocumentIds(
    tenantId: string,
    principalId: string,
    documentIds: readonly string[],
  ): Promise<DerivedJudgmentRow[]>;
  /** Unreviewed, living candidates of this principal, newest proposal first. */
  listOpen(
    tenantId: string,
    principalId: string,
    limit: number,
  ): Promise<DerivedJudgmentRow[]>;
  /**
   * Adopted rows (confirmed/edited), living, newest review first — the query-less context
   * half's scan input (FIX-W11 A-1). Everything past the review state is the caller's gates,
   * never the store's.
   */
  loadAdopted(
    tenantId: string,
    principalId: string,
    limit: number,
  ): Promise<DerivedJudgmentRow[]>;
  /** The unreviewed candidate a replayed lead would fold into, when one exists. */
  findByProposalDigest(
    tenantId: string,
    principalId: string,
    digest: string,
  ): Promise<DerivedJudgmentRow | null>;
  /** The evidence relation in lead order (position ascending). */
  loadEvidence(
    tenantId: string,
    judgmentId: string,
  ): Promise<DerivedJudgmentEvidenceRow[]>;
}

/** One evidence basis as the candidate surface shows it: content, source, and time. */
export type JudgmentEvidenceView =
  | {
      kind: "preference";
      /** The OpenBot record id — the only id this contract carries. */
      id: string;
      content: string;
      /** The source the person confirmed it from. */
      provenance: string;
      /** When the person marked this preference general. */
      markedGenericAt: Date;
      /** The fact's validity window (#386); `effectiveUntil: null` = still current. */
      effectiveFrom: Date | null;
      effectiveUntil: Date | null;
    }
  | {
      kind: "source_bound";
      id: string;
      content: string;
      provenance: string;
      /** The scope this fact stays bound to (#383). */
      restriction: SourceBoundRestrictionView;
      /** When the fact was formed — the evidence the person confirmed. */
      formedAt: Date;
    }
  | {
      kind: "derived_judgment";
      id: string;
      content: string;
      provenance: string;
      /** The judgment's own scope — all of ITS evidence's restriction, inherited. */
      scope: JudgmentScope;
      /** When that judgment was proposed (its confirmation is #389's to record). */
      proposedAt: Date;
    };

type SourceBoundRestrictionView =
  | { kind: "team"; workspaceId: string }
  | { kind: "source"; sourceId: string }
  | { kind: "bot"; agentId: string };

/** What the person (and only the person — #389's surface) sees of one candidate. */
export type DerivedJudgmentCandidate = {
  /** The OpenBot record id — the only id this contract carries. */
  id: string;
  /** The proposed judgment text, a claim over its evidence. */
  content: string;
  provenance: string;
  /** The single scope all evidence shares; the judgment inherits its restriction. */
  scope: JudgmentScope;
  reviewState: "unreviewed";
  /** When the system proposed this judgment. */
  proposedAt: Date;
  /** The complete basis, in lead order — nothing is summarized away. */
  evidence: JudgmentEvidenceView[];
};

/** Which gate refused a proposal; the derivation pipeline logs these, tests pin them. */
export type DerivedJudgmentRefusalReason =
  | "shape"
  | "missing-evidence"
  | "cross-source-evidence"
  | "unconfirmed-evidence"
  | "unauthorized-evidence"
  /** The person paused learning (#392): automatic proposals stop until they resume. */
  | "learning-paused";

export class DerivedJudgmentRefusedError extends Error {
  readonly reason: DerivedJudgmentRefusalReason;
  constructor(reason: DerivedJudgmentRefusalReason, message: string) {
    super(message);
    this.name = "DerivedJudgmentRefusedError";
    this.reason = reason;
  }
}

/** The judgment text ceiling; exported so the review seam (#389) edits under the same bound. */
export const JUDGMENT_CONTENT_MAX = 6000;
const CONTENT_MAX = JUDGMENT_CONTENT_MAX;
const PROVENANCE_MAX = 500;
/** A first-version judgment synthesizes a handful of experiences; twenty is already generous. */
const EVIDENCE_MAX = 20;
const EVIDENCE_ID_MAX = 256;
/** The review surface lists at most this many candidates per call. */
const LIST_DEFAULT = 50;
const LIST_MAX = 100;
/**
 * How many open rows one listing scans before giving up on filling the limit: candidates whose
 * evidence died are withheld, so a full page may need to look past withheld rows.
 */
const LIST_SCAN_MAX = 200;

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

function hash16(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`${namespace}:${value}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * The stable document identity of one judgment row: deterministic over the row's own
 * (tenant, id), the same discipline every other document identity follows. Assigned at
 * creation, USED only by a confirm (#389) — nothing is retained while the judgment is
 * unreviewed.
 */
export function derivedJudgmentDocumentIdFor(
  tenantId: string,
  recordId: string,
): string {
  return `hdj_${hash16("derived-judgment", `${tenantId}:${recordId}`)}`;
}

/**
 * A judgment row a recall or a NEXT-LEVEL derivation may cite: reviewed and alive. While
 * #389 does not exist no row can pass — which is exactly the property AC3 pins. Exported so
 * the review ticket reuses this gate instead of growing a copy.
 */
export const derivedJudgmentEligible = (row: DerivedJudgmentRow) =>
  row.deletedAt === null &&
  row.enabled &&
  (row.reviewState === "confirmed" || row.reviewState === "edited") &&
  row.content !== "";

/** The scope a judgment row carries, re-hydrated from its columns. */
export function judgmentScopeOf(row: DerivedJudgmentRow): JudgmentScope {
  if (row.scopeKind === "general") return { kind: "general" };
  if (row.scopeKind === "team")
    return { kind: "team", workspaceId: row.workspaceId ?? "" };
  if (row.scopeKind === "source")
    return { kind: "source", sourceId: row.sourceId ?? "" };
  return { kind: "bot", agentId: row.agentId ?? "" };
}

const restrictionViewOf = (
  row: SourceBoundRecordRow,
): SourceBoundRestrictionView =>
  row.restriction === "team"
    ? { kind: "team", workspaceId: row.workspaceId ?? "" }
    : row.restriction === "source"
      ? { kind: "source", sourceId: row.sourceId ?? "" }
      : { kind: "bot", agentId: row.agentId ?? "" };

function scopeEqual(a: JudgmentScope, b: JudgmentScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "team" && b.kind === "team")
    return a.workspaceId === b.workspaceId;
  if (a.kind === "source" && b.kind === "source")
    return a.sourceId === b.sourceId;
  if (a.kind === "bot" && b.kind === "bot") return a.agentId === b.agentId;
  return true;
}

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

/** One basis resolved to its authority row; the gates and the renderers share this shape. */
export type ResolvedEvidence =
  | { kind: "preference"; row: PreferenceAuthorityRow }
  | { kind: "source_bound"; row: SourceBoundRecordRow }
  | { kind: "derived_judgment"; row: DerivedJudgmentRow };

const scopeTagOf = (evidence: ResolvedEvidence): JudgmentScope =>
  evidence.kind === "preference"
    ? { kind: "general" }
    : evidence.kind === "source_bound"
      ? restrictionViewOf(evidence.row)
      : judgmentScopeOf(evidence.row);

/**
 * Gates 2–4 over already-resolved rows: scope unification, then review state, then current
 * authorization. Returns the unified scope on success, or the refusal reason — the caller
 * decides whether that throws (a proposal) or silently withholds (a listing).
 */
async function verifyResolvedEvidence(
  resolved: readonly ResolvedEvidence[],
  snapshot: AuthorizationSnapshot,
  authorizations: SourceBoundAuthorizationStore,
): Promise<
  | { ok: true; scope: JudgmentScope }
  | { ok: false; reason: DerivedJudgmentRefusalReason; position: number }
> {
  // Gate 2 — one scope for the whole judgment, checked before per-row state so a mixed-scope
  // lead is named as such even when one of its rows would also fail a later gate.
  let scope: JudgmentScope | null = null;
  for (const evidence of resolved) {
    const tag = scopeTagOf(evidence);
    if (scope === null) scope = tag;
    else if (!scopeEqual(scope, tag)) {
      return { ok: false, reason: "cross-source-evidence", position: 0 };
    }
  }
  for (const [index, evidence] of resolved.entries()) {
    const position = index + 1;
    // Gate 3 — only reviewed, living facts can support a judgment.
    if (evidence.kind === "preference") {
      if (!preferenceRecallEligible(evidence.row)) {
        return { ok: false, reason: "unconfirmed-evidence", position };
      }
      continue;
    }
    if (evidence.kind === "derived_judgment") {
      if (!derivedJudgmentEligible(evidence.row)) {
        return { ok: false, reason: "unconfirmed-evidence", position };
      }
      continue;
    }
    if (!sourceBoundRecallEligible(evidence.row)) {
      return { ok: false, reason: "unconfirmed-evidence", position };
    }
    // Gate 4 — source-bound evidence must still hold its authorization NOW.
    if (
      !(await sourceBoundAuthorizedNow(authorizations, evidence.row, snapshot))
    ) {
      return { ok: false, reason: "unauthorized-evidence", position };
    }
  }
  return { ok: true, scope: scope ?? { kind: "general" } };
}

/**
 * Render one resolved basis as the candidate/evidence surface shows it: content, source, and
 * time — nothing summarized away. Module-level (not service state) and exported so the review
 * seam (#389) expands a confirmed judgment's chain with the SAME rendering the candidate
 * listing used, never a second copy.
 */
export function renderEvidenceView(
  evidence: ResolvedEvidence,
): JudgmentEvidenceView {
  if (evidence.kind === "preference") {
    return {
      kind: "preference",
      id: evidence.row.id,
      content: evidence.row.content,
      provenance: evidence.row.provenance,
      markedGenericAt: evidence.row.markedGenericAt,
      effectiveFrom: evidence.row.effectiveFrom,
      effectiveUntil: evidence.row.effectiveUntil,
    };
  }
  if (evidence.kind === "source_bound") {
    return {
      kind: "source_bound",
      id: evidence.row.id,
      content: evidence.row.content,
      provenance: evidence.row.provenance,
      restriction: restrictionViewOf(evidence.row),
      formedAt: evidence.row.formedAt,
    };
  }
  return {
    kind: "derived_judgment",
    id: evidence.row.id,
    content: evidence.row.content,
    provenance: evidence.row.provenance,
    scope: judgmentScopeOf(evidence.row),
    proposedAt: evidence.row.proposedAt,
  };
}

/**
 * The four gates over a STORED evidence relation, as a reusable verifier. The review/usage
 * module (#389) re-runs exactly this verifier when confirming or editing a candidate, when
 * recalling a confirmed judgment, and when expanding the judgment's evidence chain — one
 * implementation of "the judgment stands only while its whole basis does", never a looser
 * copy. Silent by design: a candidate whose basis no longer passes is withheld or refused by
 * the CALLER; this verifier only names the gate.
 */
export function createDerivedJudgmentEvidenceVerifier(
  preferences: PreferenceRecordStore,
  sourceBound: SourceBoundRecordStore,
  judgments: DerivedJudgmentStore,
  authorizations: SourceBoundAuthorizationStore,
) {
  return {
    /**
     * The stored evidence relation, resolved back to rows by record id — the path a listing, a
     * review action, and a recall of a confirmed judgment all take.
     */
    async verifyStoredEvidence(
      tenantId: string,
      principalId: string,
      row: DerivedJudgmentRow,
      snapshot: AuthorizationSnapshot,
    ): Promise<
      | {
          ok: true;
          scope: JudgmentScope;
          evidence: ResolvedEvidence[];
        }
      | { ok: false; reason: DerivedJudgmentRefusalReason }
    > {
      const stored = await judgments.loadEvidence(tenantId, row.id);
      const resolved: ResolvedEvidence[] = [];
      for (const edge of stored) {
        if (edge.evidenceType === "preference") {
          const found = await preferences.load(tenantId, edge.evidenceId);
          if (found && found.principalId === principalId) {
            resolved.push({ kind: "preference", row: found });
            continue;
          }
          return { ok: false, reason: "missing-evidence" };
        }
        if (edge.evidenceType === "source_bound") {
          const found = await sourceBound.load(tenantId, edge.evidenceId);
          if (found && found.principalId === principalId) {
            resolved.push({ kind: "source_bound", row: found });
            continue;
          }
          return { ok: false, reason: "missing-evidence" };
        }
        const found = await judgments.load(tenantId, edge.evidenceId);
        if (found && found.principalId === principalId) {
          resolved.push({ kind: "derived_judgment", row: found });
          continue;
        }
        return { ok: false, reason: "missing-evidence" };
      }
      const verified = await verifyResolvedEvidence(
        resolved,
        snapshot,
        authorizations,
      );
      if (!verified.ok) return { ok: false, reason: verified.reason };
      return { ok: true, scope: verified.scope, evidence: resolved };
    },
  };
}

export type DerivedJudgmentEvidenceVerifier = ReturnType<
  typeof createDerivedJudgmentEvidenceVerifier
>;

export function createDerivedJudgmentService(
  preferences: PreferenceRecordStore,
  sourceBound: SourceBoundRecordStore,
  judgments: DerivedJudgmentStore,
  authorizations: SourceBoundAuthorizationStore,
  options: {
    now?: () => Date;
    /** The person's pause switches (#392); learning-paused refuses automatic proposals. */
    pause?: HindsightPauseControls;
  } = {},
) {
  const now = options.now ?? (() => new Date());

  /**
   * Gate 1 plus resolution: cite document ids, get this principal's rows back, in lead order.
   * Every store is principal-pinned, so another person's document id resolves to nothing.
   */
  async function resolveByDocumentIds(
    tenantId: string,
    principalId: string,
    documentIds: readonly string[],
  ): Promise<ResolvedEvidence[]> {
    const [preferenceRows, boundRows, judgmentRows] = await Promise.all([
      preferences.loadByDocumentIds(tenantId, principalId, documentIds),
      sourceBound.loadByDocumentIds(tenantId, principalId, documentIds),
      judgments.loadByDocumentIds(tenantId, principalId, documentIds),
    ]);
    const byDocument = new Map<string, ResolvedEvidence>();
    for (const row of preferenceRows)
      byDocument.set(row.hindsightDocumentId, { kind: "preference", row });
    for (const row of boundRows)
      byDocument.set(row.hindsightDocumentId, { kind: "source_bound", row });
    for (const row of judgmentRows)
      byDocument.set(row.hindsightDocumentId, {
        kind: "derived_judgment",
        row,
      });
    const resolved: ResolvedEvidence[] = [];
    for (const [index, documentId] of documentIds.entries()) {
      const evidence = byDocument.get(documentId);
      if (!evidence) {
        throw new DerivedJudgmentRefusedError(
          "missing-evidence",
          `Evidence at position ${index + 1} does not resolve to a confirmed record of this person in this company; the judgment is not proposed.`,
        );
      }
      resolved.push(evidence);
    }
    return resolved;
  }

  /**
   * The shared four-gate verifier; the listing below and the review seam (#389) hold the same
   * instance discipline — every read of a judgment's basis goes through this one function.
   */
  const verifier = createDerivedJudgmentEvidenceVerifier(
    preferences,
    sourceBound,
    judgments,
    authorizations,
  );

  async function snapshotFor(scope: PlatformScope): Promise<{
    tenantId: string;
    principalId: string;
    snapshot: AuthorizationSnapshot;
  }> {
    const identity = resolveHindsightBankScope(scope);
    const snapshot = await readScopedAuthorization(
      authorizations,
      identity.tenantId,
      identity.principalId,
      scope.workspaceId,
      undefined,
    );
    return {
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      snapshot,
    };
  }

  /** Render a stored candidate whose evidence has JUST re-passed all four gates. */
  async function candidateView(
    row: DerivedJudgmentRow,
    verified: { scope: JudgmentScope; evidence: ResolvedEvidence[] },
  ): Promise<DerivedJudgmentCandidate> {
    return {
      id: row.id,
      content: row.content,
      provenance: row.provenance,
      scope: verified.scope,
      reviewState: "unreviewed",
      proposedAt: row.proposedAt,
      evidence: verified.evidence.map(renderEvidenceView),
    };
  }

  return {
    /**
     * Propose a derived judgment candidate from one lead: the judgment text and the document
     * ids of the experiences it synthesizes. Every gate runs before anything is stored; a
     * refusal names its reason and leaves no row. A lead identical to a still-unreviewed
     * candidate folds into it (same id back) rather than stacking a copy. Successful or
     * refused, NOTHING is sent to Hindsight — the candidate stays a local, person-facing
     * proposal until #389 confirms it.
     */
    async proposeDerivedJudgmentCandidate(
      scope: PlatformScope,
      input: { judgment: unknown; provenance?: unknown; evidence: unknown },
    ): Promise<DerivedJudgmentCandidate> {
      const content = plainString(input.judgment, "a judgment", CONTENT_MAX);
      const provenance = plainString(
        input.provenance ?? "Hindsight",
        "provenance",
        PROVENANCE_MAX,
      );
      if (!Array.isArray(input.evidence) || input.evidence.length < 2) {
        throw new DerivedJudgmentRefusedError(
          "shape",
          "A derived judgment synthesizes multiple experiences; cite at least two evidence document ids.",
        );
      }
      if (input.evidence.length > EVIDENCE_MAX) {
        throw new DerivedJudgmentRefusedError(
          "shape",
          `A derived judgment cites at most ${EVIDENCE_MAX} pieces of evidence.`,
        );
      }
      const cited = input.evidence.map((value) =>
        plainString(value, "an evidence document id", EVIDENCE_ID_MAX),
      );
      // First-seen order preserved; a repeated citation is the same experience, not two.
      const documentIds = [...new Set(cited)];
      if (documentIds.length < 2) {
        throw new DerivedJudgmentRefusedError(
          "shape",
          "A derived judgment synthesizes multiple distinct experiences; the citations name only one.",
        );
      }
      // Pause-learning (#392): the automatic candidate-generation seam is the thing the switch
      // stops. Refused with its own reason — a pause is neither a dead basis nor a bad shape,
      // and the surface must be able to say so.
      if (await learningPausedFor(options.pause, scope)) {
        throw new DerivedJudgmentRefusedError(
          "learning-paused",
          "Learning is paused for this person; automatic candidate proposals are stopped until they resume.",
        );
      }
      const { tenantId, principalId, snapshot } = await snapshotFor(scope);
      const resolved = await resolveByDocumentIds(
        tenantId,
        principalId,
        documentIds,
      );
      const verified = await verifyResolvedEvidence(
        resolved,
        snapshot,
        authorizations,
      );
      if (!verified.ok) {
        throw refusalOf(verified);
      }
      const digest = digestOf(
        JSON.stringify({
          scope: verified.scope,
          judgment: content,
          evidence: [...documentIds].sort(),
        }),
      );
      const existing = await judgments.findByProposalDigest(
        tenantId,
        principalId,
        digest,
      );
      const rowToServe = async (): Promise<{
        row: DerivedJudgmentRow;
        verified: { scope: JudgmentScope; evidence: ResolvedEvidence[] };
      }> => {
        if (existing) {
          const reverified = await verifier.verifyStoredEvidence(
            tenantId,
            principalId,
            existing,
            snapshot,
          );
          if (!reverified.ok) {
            throw refusalOf({ ...reverified, position: 0 });
          }
          return { row: existing, verified: reverified };
        }
        const id = randomUUID();
        const at = now();
        const candidate: DerivedJudgmentRow = {
          tenantId,
          id,
          principalId,
          scopeKind: verified.scope.kind,
          workspaceId:
            verified.scope.kind === "team" ? verified.scope.workspaceId : null,
          sourceId:
            verified.scope.kind === "source" ? verified.scope.sourceId : null,
          agentId:
            verified.scope.kind === "bot" ? verified.scope.agentId : null,
          content,
          provenance,
          reviewState: "unreviewed",
          enabled: true,
          deletedAt: null,
          reviewedAt: null,
          proposalDigest: digest,
          hindsightDocumentId: derivedJudgmentDocumentIdFor(tenantId, id),
          syncedContentDigest: null,
          syncedAt: null,
          proposedAt: at,
          createdAt: at,
          updatedAt: at,
        };
        const relation = resolved.map((evidence, index) => ({
          tenantId,
          judgmentId: id,
          position: index + 1,
          evidenceType: evidence.kind,
          evidenceId: evidence.row.id,
        }));
        try {
          await judgments.create(candidate, relation);
          return {
            row: candidate,
            verified: { scope: verified.scope, evidence: resolved },
          };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // The same lead already produced a still-unreviewed candidate; serve that one.
          const folded = await judgments.findByProposalDigest(
            tenantId,
            principalId,
            digest,
          );
          if (!folded) throw error;
          const reverified = await verifier.verifyStoredEvidence(
            tenantId,
            principalId,
            folded,
            snapshot,
          );
          if (!reverified.ok) {
            throw refusalOf({ ...reverified, position: 0 });
          }
          return { row: folded, verified: reverified };
        }
      };
      const served = await rowToServe();
      return candidateView(served.row, served.verified);
    },

    /**
     * The candidate surface for the person's review (#389 builds its actions on this): open
     * candidates, newest first, each with its COMPLETE evidence — content, source, and time —
     * re-verified against current rows and CURRENT authorization. A candidate whose evidence
     * is missing, unconfirmed, de-authorized, or cross-scope by now is withheld entirely; it
     * reappears if the authority returns. This is not a recall path and no Bot reads it.
     */
    async listDerivedJudgmentCandidates(
      scope: PlatformScope,
      input: { limit?: unknown } = {},
    ): Promise<DerivedJudgmentCandidate[]> {
      let limit = LIST_DEFAULT;
      if (input.limit !== undefined) {
        if (
          typeof input.limit !== "number" ||
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > LIST_MAX
        ) {
          throw new DerivedJudgmentRefusedError(
            "shape",
            `A candidate listing needs a limit of 1..${LIST_MAX}.`,
          );
        }
        limit = input.limit;
      }
      const { tenantId, principalId, snapshot } = await snapshotFor(scope);
      const open = await judgments.listOpen(
        tenantId,
        principalId,
        LIST_SCAN_MAX,
      );
      const listed: DerivedJudgmentCandidate[] = [];
      for (const row of open) {
        const verified = await verifier.verifyStoredEvidence(
          tenantId,
          principalId,
          row,
          snapshot,
        );
        if (verified.ok) {
          listed.push(await candidateView(row, verified));
          if (listed.length === limit) break;
        }
      }
      return listed;
    },
  };
}

/**
 * The observable refusal for one failed gate. Exported so the review seam (#389) refuses a
 * confirm/edit with the SAME reason vocabulary a proposal uses — the surface can tell a dead
 * basis from an unauthorized one, and the tests pin the words.
 */
export function refusalOf(
  failure: { reason: DerivedJudgmentRefusalReason; position: number },
  outcome = "the judgment is not proposed",
): DerivedJudgmentRefusedError {
  if (failure.reason === "missing-evidence") {
    return new DerivedJudgmentRefusedError(
      failure.reason,
      `Evidence at position ${failure.position || 1} does not resolve to a confirmed record of this person in this company; ${outcome}.`,
    );
  }
  if (failure.reason === "cross-source-evidence") {
    return new DerivedJudgmentRefusedError(
      failure.reason,
      "A derived judgment may only cite confirmed evidence from one authorized source or the general personal memory; this lead mixes scopes.",
    );
  }
  if (failure.reason === "unconfirmed-evidence") {
    return new DerivedJudgmentRefusedError(
      failure.reason,
      `Evidence at position ${failure.position || 1} is not a confirmed, living fact; unreviewed or forgotten bases cannot support a judgment; ${outcome}.`,
    );
  }
  if (failure.reason === "learning-paused") {
    return new DerivedJudgmentRefusedError(
      failure.reason,
      `Learning is paused for this person; automatic candidate proposals are stopped until they resume; ${outcome}.`,
    );
  }
  return new DerivedJudgmentRefusedError(
    "unauthorized-evidence",
    `Evidence at position ${failure.position || 1} no longer holds its authorization; ${outcome}.`,
  );
}

export type DerivedJudgmentService = ReturnType<
  typeof createDerivedJudgmentService
>;

/** The SQL-backed store: mechanical persistence only, all policy lives above it. */
export function createDrizzleDerivedJudgmentRecords(
  database: Database,
): DerivedJudgmentStore {
  const candidates = derivedJudgmentCandidates;
  const relation = derivedJudgmentEvidence;
  return {
    async create(row, evidence) {
      await database.transaction(async (tx) => {
        await tx.insert(candidates).values(row);
        if (evidence.length > 0) {
          await tx.insert(relation).values([...evidence]);
        }
      });
    },
    async save(row) {
      await database
        .update(candidates)
        .set({
          content: row.content,
          provenance: row.provenance,
          reviewState: row.reviewState,
          enabled: row.enabled,
          deletedAt: row.deletedAt,
          reviewedAt: row.reviewedAt,
          syncedContentDigest: row.syncedContentDigest,
          syncedAt: row.syncedAt,
          updatedAt: row.updatedAt,
        })
        .where(
          and(eq(candidates.tenantId, row.tenantId), eq(candidates.id, row.id)),
        );
    },
    async expireUnreviewedBefore(cutoff) {
      const expired = await database
        .update(candidates)
        .set({
          reviewState: "expired",
          updatedAt: new Date(),
          reviewedAt: new Date(),
        })
        .where(
          and(
            eq(candidates.reviewState, "unreviewed"),
            lt(candidates.proposedAt, cutoff),
            eq(candidates.enabled, true),
            isNull(candidates.deletedAt),
          ),
        )
        .returning({ id: candidates.id });
      return expired.length;
    },
    async load(tenantId, id) {
      const [found] = await database
        .select()
        .from(candidates)
        .where(and(eq(candidates.tenantId, tenantId), eq(candidates.id, id)))
        .limit(1);
      return found ?? null;
    },
    async loadByDocumentIds(tenantId, principalId, documentIds) {
      if (!documentIds.length) return [];
      return database
        .select()
        .from(candidates)
        .where(
          and(
            eq(candidates.tenantId, tenantId),
            eq(candidates.principalId, principalId),
            inArray(candidates.hindsightDocumentId, [...documentIds]),
          ),
        );
    },
    async listOpen(tenantId, principalId, limit) {
      return database
        .select()
        .from(candidates)
        .where(
          and(
            eq(candidates.tenantId, tenantId),
            eq(candidates.principalId, principalId),
            eq(candidates.reviewState, "unreviewed"),
            eq(candidates.enabled, true),
            isNull(candidates.deletedAt),
          ),
        )
        .orderBy(desc(candidates.proposedAt))
        .limit(limit);
    },
    async loadAdopted(tenantId, principalId, limit) {
      return database
        .select()
        .from(candidates)
        .where(
          and(
            eq(candidates.tenantId, tenantId),
            eq(candidates.principalId, principalId),
            inArray(candidates.reviewState, ["confirmed", "edited"]),
            eq(candidates.enabled, true),
            isNull(candidates.deletedAt),
          ),
        )
        .orderBy(desc(candidates.reviewedAt), desc(candidates.updatedAt))
        .limit(limit);
    },
    async findByProposalDigest(tenantId, principalId, digest) {
      const [found] = await database
        .select()
        .from(candidates)
        .where(
          and(
            eq(candidates.tenantId, tenantId),
            eq(candidates.principalId, principalId),
            eq(candidates.proposalDigest, digest),
            eq(candidates.reviewState, "unreviewed"),
          ),
        )
        .limit(1);
      return found ?? null;
    },
    async loadEvidence(tenantId, judgmentId) {
      return database
        .select()
        .from(relation)
        .where(
          and(
            eq(relation.tenantId, tenantId),
            eq(relation.judgmentId, judgmentId),
          ),
        )
        .orderBy(asc(relation.position));
    },
  };
}
