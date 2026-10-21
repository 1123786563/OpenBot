import type { ConversionRate } from "../gateway/conversion-rate";
import type { ModelRef } from "../gateway/catalog";
import type { PayerRef } from "./payer";
import {
  AUDIO_CAPABILITY_EVIDENCE,
  enableableAudioPaths,
  type AudioCapabilityEvidenceRecord,
  type AudioPathMissingItem,
} from "./audio-capability-evidence";
import { speechTierPriceTableFromSnapshot } from "./speech-pricing";
import {
  computeReservationCeiling,
  type ReservationBoundQuantities,
  type ReservationCeilingIssue,
} from "./reserve-bound";
import type { PriceDimension, PriceSnapshotDims } from "../gateway/price-snapshot";

/*
 * The audio path admission gate (Bifrost 14.4, #313): the door an audio request lands on
 * FIRST — 14.3's evidence registry wired in before any reserve call and before any provider
 * could be reached, so an unverified audio processing path is not callable at all, and the
 * refusal names exactly which evidence item is missing.
 *
 * THE SHORT-CIRCUIT IS THE POINT. A path the registry records with structural gaps — no
 * input meter wired, no admission wiring, no wire price source (the /v1/audio/translations
 * record today) — or a family someone checked for that is not an entrance at all
 * (separation/enhancement) refuses with `audio_path_unverified` carrying the MISSING ITEMS
 * themselves, the closed codes the registry's own records carry (拒绝原因指向缺失的具体证据
 * 项). The caller is told what to fix, not merely that it failed. A basis that leaves one of
 * the path's billed dimensions `unknown` refuses with `price_unknown` naming each dimension
 * and its reason — never a zero cost (14.3's own derivation, consumed here at the door).
 * In either refusal the reserve door is never called and the dispatch never runs: no hold
 * forms, no ledger row lands, and a hold is the dispatch commitment, so the provider-side
 * proof (调用数为 0) starts from an account that provably never committed to the call
 * (拒绝不产生任何账务写入).
 *
 * ADMITTED MEANS THE PATH'S OWN EVIDENCE HELD. The positive answer does not re-derive the
 * capability's own pricing — 13.1's speech and 14.1's transcription assessors certify their
 * own quantities (the duration meter, the attested caps) and hand them in; this gate's own
 * contribution is the availability verdict plus 06.5's ceiling conversion over the LOCKED
 * basis and one reserve request whose refusal kinds pass through untouched. 补齐证据后路径可
 * 启用，无需改动其他能力: the registry is the single input the verdict reads — a record whose
 * gaps close flips its path on, and no other capability's record is consulted on the way.
 *
 * WHO CALLS THIS. The deployment's audio entrypoints — the counterpart of the chat path's
 * admission composition — with the production reserve being 06.2's CreditReserveService.
 * The reserve caller and the dispatch are injected so the wiring stays the same seam in
 * tests, and so this module itself never touches a database: the money paths stay where
 * they already live.
 */

/** Why the gate refused, in the gate's own closed stages. Displayable on any surface. */
export type AudioPathAdmissionRefusal =
  | {
      status: "refused";
      /** 14.3's registry refused before any price or door was consulted. */
      stage: "evidence";
      reasonCode: "audio_path_unverified" | "audio_path_not_an_entrance";
      /** The registry's own missing items — the specific evidence the path lacks. */
      detail: { missingItems: readonly AudioPathMissingItem[] };
    }
  | {
      status: "refused";
      /** The locked basis leaves one of the path's billed dimensions unknown. */
      stage: "enablement";
      reasonCode: "price_unknown";
      detail: {
        dimensions: readonly { dimension: PriceDimension; reason: string }[];
      };
    }
  | {
      status: "refused";
      /** The ceiling conversion could not certify a hold over the enabled path. */
      stage: "ceiling";
      reasonCode: ReservationCeilingIssue["code"] | "free_basis_zero_ceiling";
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** The reserve door refused — the door's own reason codes pass through unchanged. */
      stage: "reserve";
      reasonCode: string;
      detail: Record<string, unknown>;
    };

/** The admitted answer: what the hold carries, ready for dispatch and settlement. */
export type AudioPathAdmission = {
  status: "admitted";
  reservationId: string;
  attemptId: string;
  /** The certified ceiling the hold locked — never below the exact worst case. */
  maximumCredits: number;
  snapshotVersion: number;
  rateVersion: number;
  /** The registry record the verdict stood on — its path, family and stream variant. */
  path: string;
  family: AudioCapabilityEvidenceRecord["family"];
  stream: boolean;
};

export type AudioPathAdmissionOutcome = AudioPathAdmission | AudioPathAdmissionRefusal;

/** The seams the gate composes — production wires 06.2 and the provider dispatch. */
export type AudioPathAdmissionDependencies = {
  /** The reserve door: 06.2's CreditReserveService in production. */
  reserve: (request: unknown) => Promise<{
    status: "reserved" | "refused";
    [field: string]: unknown;
  }>;
  /** The provider dispatch: called at most once, only after a hold exists. */
  dispatch: (input: {
    path: string;
    stream: boolean;
    reservationId: string;
  }) => Promise<unknown>;
};

/** One admission request: the wire request's identity plus the locked basis it prices against. */
export type AudioPathAdmissionInput = {
  /** The audio processing path the request rides, as the registry names it. */
  path: string;
  /** The entrance's stream variant — the path's identity, with the path. */
  stream: boolean;
  /** The audio model cell being admitted. */
  model: ModelRef;
  /** The quantities the capability's own assessor certified (13.1's / 14.1's own). */
  quantities: ReservationBoundQuantities;
  /** The authorization the dispatch runs under — the reserve door re-proves it live. */
  grantId: string;
  /** The payment account claim — a claim; the door resolves the account server-side. */
  payer: PayerRef;
  /** The price basis version the request locks. */
  snapshotVersion: number;
  /** The conversion-rate version the request locks. */
  rateVersion: number;
  /** The locked basis's dims — the same version the reserve request will name. */
  dims: PriceSnapshotDims;
  /** The locked USD→credits conversion rate. */
  rate: ConversionRate;
  /** The caller's retry identity; a replay answers the original reservation. */
  idempotencyKey: string;
};

/**
 * The availability verdict (AC1/AC2), derived exactly the way 14.3 derives its projections:
 * the record's structural gaps empty AND every dimension it bills KNOWN on the basis — the
 * same machinery the admin surface reads, consumed here at the door. Pure — the same
 * registry and basis always answer the same verdict, so the admin surface, the discovery
 * readers and this gate can never disagree about what is usable.
 */
export function assessAudioPathAvailability(input: {
  path: string;
  stream: boolean;
  dims: PriceSnapshotDims;
}):
  | { available: true; record: AudioCapabilityEvidenceRecord }
  | {
      available: false;
      reasonCode:
        | "audio_path_unverified"
        | "audio_path_not_an_entrance"
        | "price_unknown";
      missingItems: readonly AudioPathMissingItem[];
      missingDimensions: readonly { dimension: PriceDimension; reason: string }[];
    } {
  const record = AUDIO_CAPABILITY_EVIDENCE.find(
    (candidate) => candidate.path === input.path && candidate.stream === input.stream,
  );
  if (record === undefined || !record.exists) {
    // A path the registry does not carry as an entrance — or carries as a checked absence
    // (separation/enhancement) — is not callable at all, and the refusal says that rather
    // than naming gaps for something that is not a path on this gateway.
    return {
      available: false,
      reasonCode: "audio_path_not_an_entrance",
      missingItems: [],
      missingDimensions: [],
    };
  }
  if (enableableAudioPaths(input.dims).some((enableable) => enableable === record)) {
    return { available: true, record };
  }
  // Not enableable on this basis: derive the gaps the way the gap report does, so the
  // door's refusal and the admin surface's gap report name the same facts — the record's
  // own structural items (with the synthesis tier-table item synthesized exactly as 14.3
  // synthesizes it), plus every dimension the basis leaves unknown.
  const missingItems: AudioPathMissingItem[] = [...record.missingItems];
  if (
    record.family === "synthesis" &&
    speechTierPriceTableFromSnapshot(input.dims).length === 0
  ) {
    missingItems.push({
      code: "no_wire_price_source",
      detail:
        "speech tier table is empty by construction (speechTierPriceTableFromSnapshot)",
    });
  }
  const missingDimensions = record.billedDimensions
    .filter((dimension) => input.dims[dimension].status === "unknown")
    .map((dimension) => ({
      dimension,
      reason:
        input.dims[dimension].status === "unknown"
          ? input.dims[dimension].reason
          : "",
    }));
  return {
    available: false,
    reasonCode:
      missingItems.length > 0 ? "audio_path_unverified" : "price_unknown",
    missingItems,
    missingDimensions,
  };
}

/**
 * The path-level availability view the admin surface reads (AC2's 界面 half): every REAL
 * path the registry carries with its structural gaps verbatim, plus a per-basis rollup —
 * for each audio-capable model cell's latest snapshot, whether THAT basis enables the path
 * and which dimensions it leaves unknown. The registry is the authority for structure; the
 * rollup never invents a verdict, it reuses {@link enableableAudioPaths} per basis, so the
 * admin row and the door's refusal can never disagree about what is usable.
 */
export type AudioPathAvailabilityRow = {
  path: string;
  family: AudioCapabilityEvidenceRecord["family"];
  stream: boolean;
  exists: boolean;
  /** The registry's own structural gaps — the codes a refusal would name. */
  missingItems: readonly AudioPathMissingItem[];
  /** One row per audio-capable cell's latest basis: enabled there, or why not. */
  bases: readonly {
    ref: string;
    enableable: boolean;
    missingDimensions: readonly { dimension: PriceDimension; reason: string }[];
  }[];
};

export function audioPathAvailabilityView(
  bases: readonly { ref: string; dims: PriceSnapshotDims }[],
): readonly AudioPathAvailabilityRow[] {
  return AUDIO_CAPABILITY_EVIDENCE.map((record) => {
    const rows = bases.map((basis) => {
      const enableable = enableableAudioPaths(basis.dims).some(
        (candidate) => candidate === record,
      );
      const missingDimensions = enableable
        ? []
        : record.billedDimensions
            .filter((dimension) => basis.dims[dimension].status === "unknown")
            .map((dimension) => ({
              dimension,
              reason:
                basis.dims[dimension].status === "unknown"
                  ? basis.dims[dimension].reason
                  : "",
            }));
      return { ref: basis.ref, enableable, missingDimensions };
    });
    return {
      path: record.path,
      family: record.family,
      stream: record.stream,
      exists: record.exists,
      missingItems: record.missingItems,
      bases: rows,
    };
  });
}

/**
 * Wire the audio entrance: availability short-circuit, ceiling certification, one reserve
 * request, one dispatch. A refusal at any stage answers with that stage's own reason and
 * leaves the account exactly as it was — the gate itself writes nothing, ever.
 */
export function createAudioPathAdmission(
  dependencies: AudioPathAdmissionDependencies,
) {
  return {
    async admit(input: AudioPathAdmissionInput): Promise<AudioPathAdmissionOutcome> {
      // 1. The availability verdict, first and cheapest: the registry before the prices,
      //    the prices before any door. A refusal here never reaches the reserve at all.
      const availability = assessAudioPathAvailability({
        path: input.path,
        stream: input.stream,
        dims: input.dims,
      });
      if (!availability.available) {
        if (availability.reasonCode === "price_unknown") {
          return {
            status: "refused",
            stage: "enablement",
            reasonCode: "price_unknown",
            detail: { dimensions: availability.missingDimensions ?? [] },
          };
        }
        return {
          status: "refused",
          stage: "evidence",
          reasonCode: availability.reasonCode,
          detail: { missingItems: availability.missingItems ?? [] },
        };
      }

      // 2. The ceiling over the SAME locked basis — 06.5's own conversion, pricing every
      //    dimension of the vocabulary against the capability's certified quantities.
      const ceiling = computeReservationCeiling({
        dims: input.dims,
        quantities: input.quantities,
        rate: input.rate,
      });
      if (!ceiling.ok) {
        return {
          status: "refused",
          stage: "ceiling",
          reasonCode: ceiling.issue.code,
          detail: { ...ceiling.issue },
        };
      }
      if (ceiling.maximumCredits === 0) {
        // A free basis certifies a hold of zero, and the Reserve contract requires a
        // positive one: free is a price, but a zero hold is not an admission — the
        // caller's policy owns that case, never a silent pass.
        return {
          status: "refused",
          stage: "ceiling",
          reasonCode: "free_basis_zero_ceiling",
          detail: { path: input.path, stream: input.stream },
        };
      }

      // 3. One reserve request, exactly the door's contract, under the caller's own
      //    idempotency identity — the door's 06.7 semantics answer a replay with the
      //    same hold.
      const reserved = await dependencies.reserve({
        grantId: input.grantId,
        payer: input.payer,
        model: input.model,
        snapshotVersion: input.snapshotVersion,
        rateVersion: input.rateVersion,
        maximumCredits: ceiling.maximumCredits,
        idempotencyKey: input.idempotencyKey,
      });
      if (reserved.status === "refused") {
        return {
          status: "refused",
          stage: "reserve",
          reasonCode: reserved.reasonCode as string,
          detail: (reserved.detail ?? {}) as Record<string, unknown>,
        };
      }

      // 4. The dispatch — once, only after the hold exists. The unverified path never
      //    reaches here: its refusal answered before the door was ever asked.
      await dependencies.dispatch({
        path: input.path,
        stream: input.stream,
        reservationId: reserved.reservationId as string,
      });
      return {
        status: "admitted",
        reservationId: reserved.reservationId as string,
        attemptId: reserved.attemptId as string,
        maximumCredits: reserved.maximumCredits as number,
        snapshotVersion: reserved.snapshotVersion as number,
        rateVersion: reserved.rateVersion as number,
        path: availability.record.path,
        family: availability.record.family,
        stream: availability.record.stream,
      };
    },
  };
}
