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
 * seams for removal. The next answer (indexed or degraded) reads the rows those operations
 * changed, which is what "the next answer reflects the latest permissions and facts" tests.
 */

import type { PlatformScope } from "../enterprise/contracts";
import { resolveHindsightBankScope } from "./bank-scope";
import {
  type PreferenceRecallService,
  type PreferenceRecordStore,
  preferenceRecallEligible,
} from "./preference-recall";
import {
  type RecalledSourceBoundMemory,
  readScopedAuthorization,
  type SourceBoundAuthorizationStore,
  type SourceBoundRecallService,
  type SourceBoundRecordStore,
  sourceBoundAuthorizedNow,
  sourceBoundRecallEligible,
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
  | UnavailableEvidence;

/** One inspect may expand at most this many bases; an answer's basis list is small. */
const EVIDENCE_IDS_MAX = 50;
const EVIDENCE_ID_MAX = 256;

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

export function createAnswerEvidenceService(
  preferences: PreferenceRecallService,
  sourceBound: SourceBoundRecallService,
  preferenceRecords: PreferenceRecordStore,
  sourceBoundRecords: SourceBoundRecordStore,
  authorizations: SourceBoundAuthorizationStore,
) {
  /** Which authority table owns an id for THIS principal (never another principal's answer). */
  async function resolveOwner(
    scope: PlatformScope,
    id: string,
  ): Promise<"preference" | "source_bound" | "none"> {
    const identity = resolveHindsightBankScope(scope);
    const preferenceRow = await preferenceRecords.load(identity.tenantId, id);
    if (preferenceRow && preferenceRow.principalId === identity.principalId) {
      return "preference";
    }
    const boundRow = await sourceBoundRecords.load(identity.tenantId, id);
    if (boundRow && boundRow.principalId === identity.principalId) {
      return "source_bound";
    }
    return "none";
  }

  return {
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
        answers.push({ state: "unavailable", id });
      }
      return answers;
    },

    /**
     * Correct a basis from the evidence entry. For a preference this is #386's time-windowed
     * correction; a source-bound fact has no correction chain — its correction is an edit of
     * the confirmed original (editEvidence), and saying so is a refusal, not a silent
     * downgrade.
     */
    async correctEvidence(
      scope: PlatformScope,
      id: string,
      input: { content: unknown; effectiveFrom?: unknown },
    ) {
      const owner = await resolveOwner(scope, id);
      if (owner === "source_bound") {
        throw new EvidenceRefusedError(
          "A source-bound fact is corrected by editing its original; time-windowed corrections apply to general preferences only.",
        );
      }
      if (owner === "none") throw new EvidenceNotFoundError();
      return preferences.correctGenericPreference(scope, id, input);
    },

    /** Edit a basis's confirmed original, on whichever authority table owns it. */
    async editEvidence(
      scope: PlatformScope,
      id: string,
      input: { content: unknown },
    ) {
      const owner = await resolveOwner(scope, id);
      if (owner === "preference") {
        return preferences.editGenericPreference(scope, id, input);
      }
      if (owner === "source_bound") {
        return sourceBound.editSourceBoundMemory(scope, id, input);
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
      throw new EvidenceNotFoundError();
    },
  };
}

export type AnswerEvidenceService = ReturnType<
  typeof createAnswerEvidenceService
>;
