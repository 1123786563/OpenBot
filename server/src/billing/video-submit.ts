import type { ModelRef } from "../gateway/catalog";
import type { ConversionRate } from "../gateway/conversion-rate";
import type { PriceSnapshotDims } from "../gateway/price-snapshot";
import type { PayerRef } from "./payer";
import {
  computeReservationCeiling,
  type ReservationBoundQuantities,
} from "./reserve-bound";
import {
  assessVideoEditEnablement,
  type VideoEditRequestType,
  videoEditCeilingDims,
} from "./video-edit-pricing";
import {
  assessVideoGenerationEnablement,
  type VideoTierPriceTable,
  videoGenerationCeilingDims,
  videoTierPriceTableFromSnapshot,
} from "./video-generation-pricing";

/*
 * The video submit path (Bifrost 19.1, #337 — the 提交预留 wiring; 19.3's edit/remix
 * shapes ride the same lane): one video request = one full-cap reservation = one async
 * job, through 17.2's OWN submit service, not a second reservation system beside it.
 *
 * THE VIDEO LINE OWNS THE SPEC; 17.2 OWNS THE MONEY. This module's whole job is the
 * adapter: freeze the request's spec through the line's own extraction (generation, or
 * the edit/remix shape whose input side 19.3 prices), price the worst case against the
 * LOCKED basis, and hand 17.2's `createAsyncSubmitService` an entries list whose
 * quantities are the certified video seconds (and input seconds, for the edit shape).
 * Everything the strict-billing ACs name — the idempotency-key convergence, the hold
 * BEFORE the dispatch, the dispatch-lost → 06.8 unknown with the FULL cap occupied, the
 * unique job row, the payer resolved server-side — is 17.2's own delivered contract,
 * consumed here exactly as the group-19 tickets' Consumes section demands (不臆测：以
 * 实际实现为准).
 *
 * ONE LANE, BOTH SHAPES (19.3's AC3: 编辑、变体与生成共用同一预留与结算语义). The
 * entrance names its request type; the generation verdict and the edit verdict differ
 * only in what the spec froze — the edit adds the input side's seconds on `video_input`
 * — and both submit through this one path into the same 17.2 service and settle through
 * the same 17.6 lane. There is no edit-specific reservation system to drift.
 *
 * THE REFUSAL ORDERING IS THE VIDEO LINE'S OWN GATE (19.2's short-circuit). A spec that
 * cannot be fixed, or a tier/basis the locked basis does not price, refuses at the
 * enablement stage — BEFORE the submit service is called at all: no reserve door call,
 * no ledger seam, no provider dispatch (供应商派发数为 0), and the refusal names the
 * dimension it is missing. The door's own refusals (balance above all, grant invalid)
 * pass through as the submit stage's refusals, exactly as the image matrix passes the
 * reserve door's vocabulary through.
 *
 * WHO CALLS THIS. The deployment's video entrances, with the production submit being
 * 17.2's `createAsyncSubmitService` (its own reserve seam is 06.2's CreditReserveService
 * and its dispatch seam the gateway's video client — both injected THERE, none here).
 */

/** The shape 17.2's submit service answers, one seam over for this adapter's callers. */
export type VideoAsyncSubmitOutcome =
  | { status: "submitted"; [field: string]: unknown }
  | { status: "refused"; reasonCode: string; detail?: Record<string, unknown> };

/** The shape 17.2's basis seam answers — the same contract the submit service consumes. */
export type VideoBasisResolution =
  | {
      ok: true;
      dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
      rate: ConversionRate;
    }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

export type VideoSubmitServiceDependencies = {
  /** The locked-basis seam, verbatim 17.2's own — resolved from the request's versions. */
  resolveBasis: (model: {
    provider: string;
    model: string;
    capability: string;
    snapshotVersion: number;
    rateVersion: number;
  }) => Promise<VideoBasisResolution>;
  /**
   * The tier table resolved FOR THE LOCKED BASIS. Defaults to the snapshot-derived table
   * (the wildcard row a known `video` amount fills); a caller holding per-tier rows
   * (a curated cell) hands them here and the spec resolves against THOSE.
   */
  tierTableFor?: (dims: PriceSnapshotDims) => Promise<VideoTierPriceTable>;
  /** 17.2's own submit service — the money, the job row and the dispatch live there. */
  asyncSubmit: (request: unknown) => Promise<VideoAsyncSubmitOutcome>;
};

/** One video submit request: the caller's durable identity, the versions, the wire body. */
export type VideoSubmitInput = {
  submitIdempotencyKey: string;
  grantId: string;
  payer: PayerRef;
  model: ModelRef;
  snapshotVersion: number;
  rateVersion: number;
  /** The video request as it will be sent — the line's own extraction freezes the spec. */
  request: unknown;
  /**
   * The entrance's request type: `generation` (the default) or 19.3's edit/remix shapes,
   * whose input side the edit assessor prices. The entrance names it; nothing is sniffed.
   */
  requestType?: VideoEditRequestType | "generation";
};

/** Why the video submit refused, in this adapter's own closed stages. Displayable. */
export type VideoSubmitRefusal =
  | {
      status: "refused";
      /** The spec or the tier refused before any submit service call. */
      stage: "enablement" | "basis" | "ceiling";
      reasonCode: string;
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** 17.2's own refusal passed through — its vocabulary, its detail. */
      stage: "submit";
      reasonCode: string;
      detail: Record<string, unknown>;
    };

export type VideoSubmitOutcome =
  | { status: "submitted"; [field: string]: unknown }
  | VideoSubmitRefusal;

/**
 * The video submit adapter: freeze the spec, price the worst case on the locked basis,
 * then hand 17.2's submit service the one entry the certified seconds are. The ceiling
 * this module computes is the same number 17.2's cap conversion re-derives from the
 * entry — computing it here first means a spec whose ceiling cannot certify (a free
 * basis, a ledger-overflow) refuses at THIS door, before the submit service is reached.
 */
export function createVideoSubmitService(
  dependencies: VideoSubmitServiceDependencies,
) {
  const { resolveBasis, asyncSubmit } = dependencies;
  const tierTableFor =
    dependencies.tierTableFor ??
    (async (dims: Parameters<typeof videoTierPriceTableFromSnapshot>[0]) =>
      videoTierPriceTableFromSnapshot(dims));

  return {
    async submitVideo(input: VideoSubmitInput): Promise<VideoSubmitOutcome> {
      // 1. The basis first: the versions the request locks are the versions everything
      //    downstream prices against, exactly as 17.2's own ordering resolves them.
      const basis = await resolveBasis({
        provider: input.model.provider,
        model: input.model.model,
        capability: input.model.capability,
        snapshotVersion: input.snapshotVersion,
        rateVersion: input.rateVersion,
      });
      if (!basis.ok) {
        return {
          status: "refused",
          stage: "basis",
          reasonCode: "price_basis_not_found",
          detail: { reason: basis.reason, ...(basis.detail ?? {}) },
        };
      }

      // 2. The spec and the tier — the line's own predicate for the entrance's own shape,
      //    on the locked basis's table. A refusal here never reaches the submit service:
      //    no hold, no job, no dispatch.
      const tierTable = await tierTableFor(basis.dims);
      const requestType = input.requestType ?? "generation";
      const isEditShape = requestType !== "generation";

      // Each shape's verdict, ceiling overlay and entry, in its own branch: the shapes
      // differ ONLY in what the spec froze (the edit adds the input side's seconds and
      // its own locked rate) — the conversion, the submit and the settlement are shared.
      type PricedSpec =
        | {
            ok: true;
            perSecondUsd: string;
            quantities: ReservationBoundQuantities;
            overlaid: Parameters<typeof computeReservationCeiling>[0]["dims"];
            entry: { video: number; video_input?: number };
          }
        | { ok: false; issue: { code: string; [field: string]: unknown } };
      const priced: PricedSpec = isEditShape
        ? (() => {
            const verdict = assessVideoEditEnablement({
              dims: basis.dims,
              tierTable,
              request: input.request,
              requestType,
            });
            return verdict.enabled
              ? {
                  ok: true as const,
                  perSecondUsd: verdict.perSecondUsd,
                  quantities: verdict.quantities,
                  overlaid: videoEditCeilingDims(
                    basis.dims,
                    verdict.perSecondUsd,
                    verdict.inputPerSecondUsd,
                  ),
                  entry: {
                    video: verdict.quantities.video,
                    video_input: verdict.quantities.video_input,
                  },
                }
              : { ok: false as const, issue: verdict.issue };
          })()
        : (() => {
            const verdict = assessVideoGenerationEnablement({
              dims: basis.dims,
              tierTable,
              request: input.request,
            });
            return verdict.enabled
              ? {
                  ok: true as const,
                  perSecondUsd: verdict.perSecondUsd,
                  quantities: verdict.quantities,
                  overlaid: videoGenerationCeilingDims(
                    basis.dims,
                    verdict.perSecondUsd,
                  ),
                  entry: { video: verdict.quantities.video },
                }
              : { ok: false as const, issue: verdict.issue };
          })();
      if (!priced.ok) {
        return {
          status: "refused",
          stage: "enablement",
          reasonCode: priced.issue.code,
          detail: { ...priced.issue },
        };
      }

      // 3. The ceiling over the overlaid basis — the same 06.5 arithmetic 17.2's cap
      //    conversion will run, computed here so a ceiling that cannot certify (a free
      //    basis's zero hold, a ledger overflow) refuses at this door first.
      const ceiling = computeReservationCeiling({
        dims: priced.overlaid,
        quantities: priced.quantities,
        rate: basis.rate,
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
        // positive one — free is the caller's policy, never a silent pass (the image
        // matrix's own rule, kept verbatim).
        return {
          status: "refused",
          stage: "ceiling",
          reasonCode: "free_basis_zero_ceiling",
          detail: { perSecondUsd: priced.perSecondUsd },
        };
      }

      // 4. 17.2's own submit — one entry carrying the certified worst-case seconds (the
      //    edit shape's entry carries both sides). The submit service reserves, inserts
      //    the unique job row and dispatches under its own ordering and idempotency; a
      //    refusal passes through.
      const submitted = await asyncSubmit({
        submitIdempotencyKey: input.submitIdempotencyKey,
        grantId: input.grantId,
        payer: input.payer,
        model: {
          provider: input.model.provider,
          model: input.model.model,
          capability: input.model.capability,
        },
        snapshotVersion: input.snapshotVersion,
        rateVersion: input.rateVersion,
        entries: [{ quantities: priced.entry }],
      });
      if (submitted.status === "refused") {
        return {
          status: "refused",
          stage: "submit",
          reasonCode: submitted.reasonCode,
          detail: (submitted.detail ?? {}) as Record<string, unknown>,
        };
      }
      return submitted;
    },
  };
}

export type VideoSubmitService = ReturnType<typeof createVideoSubmitService>;
