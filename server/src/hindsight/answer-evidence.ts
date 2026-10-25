/**
 * Hindsight 10 (#387): the expandable evidence behind a personal-memory answer.
 *
 * An answer a Bot gives out of recalled memories cites record ids — the only id any recall
 * view carries. This seam turns those ids back into the full chain the person is entitled to
 * inspect: the HIT (the id the answer used) → the ORIGINAL (the confirmed bytes re-loaded from
 * the authority table, never anything the index derived) → the SOURCE AUTHORIZATION (the
 * provenance, and for a source-bound fact the restriction it stays bound to, re-verified
 * against CURRENT authorization the same way #383's recall verifies it). Preference evidence
 * additionally carries the fact's validity window from #386, so an answer that spoke about a
 * historical change can be expanded into exactly what was in force, when, and with how much
 * time certainty.
 *
 * The unavailable state is the seam's other half. A basis that is missing, belongs to another
 * principal, is still unreviewed, was forgotten, or whose restriction is no longer authorized
 * answers `{ state: "unavailable" }` — no content, no provenance, no restriction target, and
 * deliberately no reason: distinguishing "never existed" from "revoked" would itself leak.
 * Nothing is ever inferred into the gap; the interface says unavailable and means it.
 *
 * The correction and forgetting entries live here too, because the ticket's requirement is
 * that the person can act FROM the evidence: `editEvidence`, `correctEvidence` and
 * `forgetEvidence` dispatch by which authority table owns the id and delegate to the seam that
 * owns the policy — `correctGenericPreference` for a preference's time-windowed correction,
 * `editSourceBoundMemory` for a source-bound fact's plain correction, and the two forget
 * seams for removal. Since #389 a cited id may also be a confirmed/edited derived judgment:
 * it expands with its complete basis one level deep (a nested judgment carries its own id for
 * the next expansion), and its edit/forget dispatch to the judgment review seam, which
 * re-runs the evidence gates and never widens the judgment's scope. The next answer (indexed
 * or degraded) reads the rows those operations changed, which is what "the next answer
 * reflects the latest permissions and facts" tests.
 */

import type { PlatformScope } from "../enterprise/contracts";
import { resolveHindsightBankScope } from "./bank-scope";
import type { JudgmentEvidenceView } from "./derived-judgments";
import type {
  DerivedJudgmentInspection,
  DerivedJudgmentReviewService,
} from "./judgment-review";
import {
  type PreferenceRecallService,
  type PreferenceRecordStore,
  preferenceRecallEligible,
} from "./preference-recall";
import {
  type AuthorizationSnapshot,
  type RecalledSourceBoundMemory,
  readScopedAuthorization,
  type SourceBoundAuthorizationStore,
  type SourceBoundRecallService,
  type SourceBoundRecordRow,
  type SourceBoundRecordStore,
  sourceBoundRecallEligible,
  stillAuthorized,
} from "./scoped-recall";

/** What the person may launch from one preference basis. */
export type PreferenceEvidence = {
  state: "available";
  kind: "preference";
  /** The hit: the record id the answer cited. */
  id: string;
  /** The original: the confirmed bytes re-loaded at inspect time. */
  content: string;
  /** The source the person confirmed it from. */
  provenance: string;
  /** When the person marked this preference general — the marking's evidence. */
  markedGenericAt: Date;
  /** #386's validity window; `effectiveUntil: null` is the still-open current fact. */
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  /** The correcting row when this basis is a superseded historical fact; null = chain head. */
  supersededBy: string | null;
  /** The window closed at an unknowable time — display the uncertainty, never a date. */
  supersededTimeUnknown: boolean;
  /** When the person made the correction that closed this row. */
  correctedAt: Date | null;
  actions: ("edit" | "correct" | "forget")[];
};

/** What the person may launch from one source-bound basis. */
export type SourceBoundEvidence = {
  state: "available";
  kind: "source_bound";
  id: string;
  content: string;
  provenance: string;
  /**
   * The scope this fact stays bound to (#383's authorization fact, re-verified now): the
   * forming team, source, or Bot whose current authorization gates the fact's visibility.
   */
  restriction: RecalledSourceBoundMemory["restriction"];
  /** When the fact was formed — the evidence the person confirmed. */
  formedAt: Date;
  actions: ("edit" | "forget")[];
};

/** Missing, foreign, unreviewed, forgotten, or no-longer-authorized — indistinguishable. */
export type UnavailableEvidence = {
  state: "unavailable";
  id: string;
};

export type PersonalMemoryEvidence =
  | PreferenceEvidence
  | SourceBoundEvidence
  /** A confirmed/edited derived judgment with its complete basis, one level deep (#389). */
  | Extract<DerivedJudgmentInspection, { state: "available" }>
  | UnavailableEvidence;

/** One inspect may expand at most this many bases; an answer's basis list is small. */
const EVIDENCE_IDS_MAX = 50;
const EVIDENCE_ID_MAX = 256;
/** The memory listing's page discipline, kept beside the other surface ceilings. */
const MEMORIES_LIST_DEFAULT = 50;
const MEMORIES_LIST_MAX = 100;
/** How many living rows one listing scans past withheld rows to fill its page. */
const MEMORIES_LIST_SCAN_MAX = 200;

export class EvidenceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceRefusedError";
  }
}

export class EvidenceNotFoundError extends Error {
  constructor() {
    super("This personal-memory basis could not be found.");
    this.name = "EvidenceNotFoundError";
  }
}

function evidenceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > EVIDENCE_ID_MAX
  ) {
    throw new EvidenceRefusedError(
      `Evidence ids must be strings of 1..${EVIDENCE_ID_MAX} characters.`,
    );
  }
  return value;
}

/**
 * Whether a source-bound row is evidence-visible under one live authorization read. Team rows
 * answer only the asking workspace; source rows only while the source is enabled; Bot rows
 * only while that Bot still holds its app — the same rule the recall enforces, read through
 * the same store.
 */
async function sourceBoundAuthorizedNow(
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

export function createAnswerEvidenceService(
  preferences: PreferenceRecallService,
  sourceBound: SourceBoundRecallService,
  preferenceRecords: PreferenceRecordStore,
  sourceBoundRecords: SourceBoundRecordStore,
  authorizations: SourceBoundAuthorizationStore,
  judgmentReview: Pick<
    DerivedJudgmentReviewService,
    | "inspectJudgmentEvidence"
    | "editDerivedJudgment"
    | "forgetDerivedJudgment"
    | "ownsJudgment"
  >,
) {
  /** Which authority table owns an id for THIS principal (never another principal's answer). */
  async function resolveOwner(
    scope: PlatformScope,
    id: string,
  ): Promise<"preference" | "source_bound" | "derived_judgment" | "none"> {
    const identity = resolveHindsightBankScope(scope);
    const preferenceRow = await preferenceRecords.load(identity.tenantId, id);
    if (preferenceRow && preferenceRow.principalId === identity.principalId) {
      return "preference";
    }
    const boundRow = await sourceBoundRecords.load(identity.tenantId, id);
    if (boundRow && boundRow.principalId === identity.principalId) {
      return "source_bound";
    }
    if (await judgmentReview.ownsJudgment(scope, id)) {
      return "derived_judgment";
    }
    return "none";
  }

  return {
    /**
     * The person's own Hindsight memory entries (FIX-W12 FR2-3, #387 AC1): the confirmed
     * preferences and source-bound facts a Bot's answers read, newest change first — the
     * listing the answer-basis surface expands FROM, so the person can verify, correct or
     * forget an entry without waiting for a judgment to cite it. The entries answer in the
     * same view the judgment basis uses, and availability is re-decided per row exactly as
     * `inspectEvidence` decides it: living, eligible, and (for a source-bound fact) still
     * inside its CURRENT authorization. A row that fails is withheld, never shown stale.
     */
    async listPersonalMemories(
      scope: PlatformScope,
      input: { limit?: unknown } = {},
    ): Promise<JudgmentEvidenceView[]> {
      let limit = MEMORIES_LIST_DEFAULT;
      if (input.limit !== undefined) {
        if (
          typeof input.limit !== "number" ||
          !Number.isInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > MEMORIES_LIST_MAX
        ) {
          throw new EvidenceRefusedError(
            `A memory listing needs a limit of 1..${MEMORIES_LIST_MAX}.`,
          );
        }
        limit = input.limit;
      }
      const identity = resolveHindsightBankScope(scope);
      const base = await readScopedAuthorization(
        authorizations,
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        undefined,
      );
      const [preferenceRows, boundRows] = await Promise.all([
        preferenceRecords.listLiving(
          identity.tenantId,
          identity.principalId,
          MEMORIES_LIST_SCAN_MAX,
        ),
        sourceBoundRecords.listLiving(
          identity.tenantId,
          identity.principalId,
          MEMORIES_LIST_SCAN_MAX,
        ),
      ]);
      const candidates: { at: Date; view: JudgmentEvidenceView }[] = [];
      for (const row of preferenceRows) {
        if (!preferenceRecallEligible(row)) continue;
        candidates.push({
          at: row.updatedAt,
          view: {
            kind: "preference",
            id: row.id,
            content: row.content,
            provenance: row.provenance,
            markedGenericAt: row.markedGenericAt,
            effectiveFrom: row.effectiveFrom,
            effectiveUntil: row.effectiveUntil,
          },
        });
      }
      for (const row of boundRows) {
        if (!sourceBoundRecallEligible(row)) continue;
        if (!(await sourceBoundAuthorizedNow(authorizations, row, base)))
          continue;
        candidates.push({
          at: row.updatedAt,
          view: {
            kind: "source_bound",
            id: row.id,
            content: row.content,
            provenance: row.provenance,
            restriction:
              row.restriction === "team"
                ? { kind: "team", workspaceId: row.workspaceId ?? "" }
                : row.restriction === "source"
                  ? { kind: "source", sourceId: row.sourceId ?? "" }
                  : { kind: "bot", agentId: row.agentId ?? "" },
            formedAt: row.formedAt,
          },
        });
      }
      candidates.sort((left, right) => right.at.getTime() - left.at.getTime());
      return candidates.slice(0, limit).map((entry) => entry.view);
    },

    /**
     * Expand the record ids an answer used into their evidence, one entry per id in input
     * order. Availability is re-decided per row at inspect time — the answer's citation is a
     * claim, and this seam re-reads both the row and the current authorization before any
     * content is shown.
     */
    async inspectEvidence(
      scope: PlatformScope,
      input: { ids: unknown },
    ): Promise<PersonalMemoryEvidence[]> {
      if (!Array.isArray(input.ids) || input.ids.length === 0) {
        throw new EvidenceRefusedError(
          "Evidence inspection needs a non-empty array of record ids.",
        );
      }
      if (input.ids.length > EVIDENCE_IDS_MAX) {
        throw new EvidenceRefusedError(
          `At most ${EVIDENCE_IDS_MAX} bases may be expanded at once.`,
        );
      }
      const ids = input.ids.map(evidenceId);
      // The trusted-scope assertion and identity pin happen here, before any read: a forged
      // scope is refused before it can probe whose rows exist.
      const identity = resolveHindsightBankScope(scope);
      // One authorization read serves the whole inspection; Bot-restricted rows add their own
      // per-row Bot check on top (see sourceBoundAuthorizedNow).
      const base = await readScopedAuthorization(
        authorizations,
        identity.tenantId,
        identity.principalId,
        scope.workspaceId,
        undefined,
      );
      const answers: PersonalMemoryEvidence[] = [];
      for (const id of ids) {
        const preferenceRow = await preferenceRecords.load(
          identity.tenantId,
          id,
        );
        if (
          preferenceRow &&
          preferenceRow.principalId === identity.principalId &&
          preferenceRecallEligible(preferenceRow)
        ) {
          answers.push({
            state: "available",
            kind: "preference",
            id: preferenceRow.id,
            content: preferenceRow.content,
            provenance: preferenceRow.provenance,
            markedGenericAt: preferenceRow.markedGenericAt,
            effectiveFrom: preferenceRow.effectiveFrom,
            effectiveUntil: preferenceRow.effectiveUntil,
            supersededBy: preferenceRow.supersededBy,
            supersededTimeUnknown: preferenceRow.supersededTimeUnknown,
            correctedAt: preferenceRow.correctedAt,
            actions: ["edit", "correct", "forget"],
          });
          continue;
        }
        const boundRow = await sourceBoundRecords.load(identity.tenantId, id);
        if (
          boundRow &&
          boundRow.principalId === identity.principalId &&
          sourceBoundRecallEligible(boundRow) &&
          (await sourceBoundAuthorizedNow(authorizations, boundRow, base))
        ) {
          answers.push({
            state: "available",
            kind: "source_bound",
            id: boundRow.id,
            content: boundRow.content,
            provenance: boundRow.provenance,
            restriction:
              boundRow.restriction === "team"
                ? { kind: "team", workspaceId: boundRow.workspaceId ?? "" }
                : boundRow.restriction === "source"
                  ? { kind: "source", sourceId: boundRow.sourceId ?? "" }
                  : { kind: "bot", agentId: boundRow.agentId ?? "" },
            formedAt: boundRow.formedAt,
            actions: ["edit", "forget"],
          });
          continue;
        }
        // A confirmed/edited derived judgment expands with its complete basis; the judgment's
        // own policy (re-verified adoption, scope, and evidence gates) lives in #389's seam.
        const judgment = await judgmentReview.inspectJudgmentEvidence(
          scope,
          id,
        );
        if (judgment.state === "available") {
          answers.push(judgment);
          continue;
        }
        answers.push({ state: "unavailable", id });
      }
      return answers;
    },

    /**
     * Correct a basis from the evidence entry. For a preference this is #386's time-windowed
     * correction — the ONLY basis kind whose evidence entry offers `correct` — and the
     * sensitivity gate of that seam applies to the corrected text. The other two kinds have
     * no correction chain, and saying so is a refusal, never a silent downgrade: a
     * source-bound fact is corrected by editing its original, and since #389 a judgment's
     * text is re-asserted through its own edit (whose evidence gates re-run).
     */
    async correctEvidence(
      scope: PlatformScope,
      id: string,
      input: {
        content: unknown;
        effectiveFrom?: unknown;
        /** The person's explicit second confirmation for sensitive content (F-G1-4). */
        confirmSensitive?: unknown;
      },
    ) {
      const owner = await resolveOwner(scope, id);
      if (owner === "source_bound") {
        throw new EvidenceRefusedError(
          "A source-bound fact is corrected by editing its original; time-windowed corrections apply to general preferences only.",
        );
      }
      if (owner === "derived_judgment") {
        throw new EvidenceRefusedError(
          "A judgment is corrected by editing its text; time-windowed corrections apply to general preferences only.",
        );
      }
      if (owner === "none") throw new EvidenceNotFoundError();
      return preferences.correctGenericPreference(scope, id, input);
    },

    /**
     * Edit a basis's confirmed original, on whichever authority table owns it.
     *
     * FIX-OCR3 (O3-M8): the second confirmation rides here exactly as it does on the
     * correction next door — every owner seam's edit re-runs the same sensitivity gate, and
     * an edit that arrived without this field would be unconfirmable sensitive material: the
     * refusal has no second look to give. The whole input object is forwarded, so this is a
     * declaration, not a new wire shape.
     */
    async editEvidence(
      scope: PlatformScope,
      id: string,
      input: {
        content: unknown;
        /** The person's explicit second confirmation for sensitive content (F-G1-4). */
        confirmSensitive?: unknown;
      },
    ) {
      const owner = await resolveOwner(scope, id);
      if (owner === "preference") {
        return preferences.editGenericPreference(scope, id, input);
      }
      if (owner === "source_bound") {
        return sourceBound.editSourceBoundMemory(scope, id, input);
      }
      if (owner === "derived_judgment") {
        // The judgment's edit re-runs its evidence gates and touches the text alone (#389).
        return judgmentReview.editDerivedJudgment(scope, id, input);
      }
      throw new EvidenceNotFoundError();
    },

    /** Forget a basis, on whichever authority table owns it. */
    async forgetEvidence(scope: PlatformScope, id: string) {
      const owner = await resolveOwner(scope, id);
      if (owner === "preference") {
        return preferences.forgetGenericPreference(scope, id);
      }
      if (owner === "source_bound") {
        return sourceBound.forgetSourceBoundMemory(scope, id);
      }
      if (owner === "derived_judgment") {
        return judgmentReview.forgetDerivedJudgment(scope, id);
      }
      throw new EvidenceNotFoundError();
    },
  };
}

export type AnswerEvidenceService = ReturnType<
  typeof createAnswerEvidenceService
>;
