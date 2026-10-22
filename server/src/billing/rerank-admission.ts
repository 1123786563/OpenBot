import type { ModelRef } from "../gateway/catalog";
import type { ConversionRate } from "../gateway/conversion-rate";
import type { PayerRef } from "./payer";
import { assessRerankEnablement } from "./rerank-pricing";
import {
  computeReservationCeiling,
  type ReservationCeilingIssue,
} from "./reserve-bound";

/*
 * The rerank admission wiring (Bifrost 11.4, #299): the door a rerank dispatch lands on —
 * 11.3's enablement verdict wired in FIRST, so a request whose cell does not price the
 * rerank's own billed dimensions is refused at the entry, before any reserve call and
 * before any provider could be reached.
 *
 * THE SHORT-CIRCUIT IS THE POINT. A missing dimension is not a zero cost and never a
 * "let the gateway compute zero" pass (Q11): the entry refuses with `rerank_price_unknown`
 * carrying THE missing dimension and its per-dimension reason — the administrator prices
 * exactly what the refusal names — or with `rerank_input_uncountable` naming the shape,
 * which the verdict itself checks BEFORE any price is consulted. In either refusal the
 * reserve door is never called: no hold forms, no ledger row lands, and a hold is the
 * dispatch commitment, so the provider-side proof (调用数为 0) starts from an account
 * that provably never committed to the call. The general reserve door agrees on its own
 * when driven directly — 03.3's classification refuses the same basis with its
 * missing-dimension list — but the entry's refusal is the rerank's OWN answer, naming the
 * dimension a rerank bills, not the wire's whole set.
 *
 * ADMITTED MEANS HELD. Once the verdict enables, the entry certifies the hold ceiling
 * through 06.5's own conversion over the LOCKED basis (counted tokens × the input price +
 * documents × the flat price, 足额) and sends ONE reserve request whose bound evidence is
 * the rerank's honest self-enforcement: the input counted in full and refused over the
 * ceiling — `self_enforced_input_refusal`, the same kind 11.1/11.2 established for
 * counted-in-full inputs whose truncation would change the answer. The reserve's own
 * refusals (grant, freshness, balance — the door's seven verdicts) pass through
 * untouched; a free basis (ceiling exactly 0) cannot form a hold and is refused with the
 * zero-ceiling code, because a hold of zero is not a hold and free is the CALLER's
 * policy to make, never this door's to assume.
 *
 * WHO CALLS THIS. The deployment's rerank entrypoint — the counterpart of the chat path's
 * admission composition — with the production reserve being 06.2's CreditReserveService.
 * The reserve caller is injected so the wiring stays the same seam in tests, and so this
 * module itself never touches a database: the money paths stay where they already live.
 */

/** Why the entry refused, in the entry's own closed stages. Displayable on any surface. */
export type RerankAdmissionRefusal =
  | {
      status: "refused";
      /** 11.3's verdict refused before the door was reached (the short-circuit). */
      stage: "enablement";
      reasonCode: "rerank_price_unknown" | "rerank_input_uncountable";
      /** The verdict's own detail: the missing dimension + reason, or the uncountable shape. */
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** The ceiling conversion could not certify a hold over the enabled verdict. */
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
export type RerankAdmission = {
  status: "admitted";
  reservationId: string;
  attemptId: string;
  /** The certified ceiling the hold locked — never below the exact worst case. */
  maximumCredits: number;
  snapshotVersion: number;
  rateVersion: number;
  /** The conservative input-token count the hold's bound evidence attests. */
  inputTokens: number;
  /** How many documents the flat side covered — the surcharge quantity's basis. */
  documents: number;
};

export type RerankAdmissionOutcome = RerankAdmission | RerankAdmissionRefusal;

/** The environment the admission runs in: the reserve door, and nothing else. */
export type RerankAdmissionDependencies = {
  /** The reserve caller — 06.2's CreditReserveService in production. */
  reserve: (request: unknown) => Promise<{
    status: "reserved" | "refused";
    [field: string]: unknown;
  }>;
};

/** One admission request: the wire request plus the locked basis it prices against. */
export type RerankAdmissionInput = {
  /** The rerank request as it will be sent ({ model, query, documents }). */
  request: unknown;
  /** The authorization the dispatch runs under — the reserve door re-proves it live. */
  grantId: string;
  /** The payment account claim — a claim; the door resolves the account server-side. */
  payer: PayerRef;
  /** The rerank model cell being admitted. */
  model: ModelRef;
  /** The price basis version the request locks. */
  snapshotVersion: number;
  /** The conversion-rate version the request locks. */
  rateVersion: number;
  /** The locked basis's dims — the same version the reserve request will name. */
  dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
  /** The locked USD→credits conversion rate. */
  rate: ConversionRate;
  /** The caller's retry identity; a replay answers the original reservation. */
  idempotencyKey: string;
};

/**
 * Wire the rerank entry: enablement short-circuit, ceiling certification, one reserve
 * request. A refusal at any stage answers with that stage's own reason and leaves the
 * account exactly as it was — the entry never writes anything itself.
 */
export function createRerankAdmission(
  dependencies: RerankAdmissionDependencies,
) {
  return {
    async admit(input: RerankAdmissionInput): Promise<RerankAdmissionOutcome> {
      // 1. The enablement verdict, first and cheapest: shape before prices, prices
      //    before any door. A refusal here never reaches the reserve at all.
      const verdict = assessRerankEnablement({
        dims: input.dims,
        params: input.request,
      });
      if (!verdict.enabled) {
        const issue = verdict.issue;
        return {
          status: "refused",
          stage: "enablement",
          reasonCode: issue.code,
          detail:
            issue.code === "rerank_price_unknown"
              ? { dimension: issue.dimension, reason: issue.reason }
              : { shape: issue.shape },
        };
      }

      // 2. The ceiling over the SAME locked basis — 06.5's own conversion, pricing every
      //    dimension of the vocabulary against the verdict's certified quantities.
      const ceiling = computeReservationCeiling({
        dims: input.dims,
        quantities: verdict.quantities,
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
          detail: {
            inputTokens: verdict.inputTokens,
            documents: verdict.documents,
          },
        };
      }

      // 3. One reserve request, exactly the door's contract: the counted-in-full input
      //    bound (refused over the ceiling — never truncated, the documents are the
      //    payload), the certified maximum, the locked versions.
      const reserved = await dependencies.reserve({
        grantId: input.grantId,
        payer: input.payer,
        model: input.model,
        snapshotVersion: input.snapshotVersion,
        rateVersion: input.rateVersion,
        boundEvidence: [
          {
            kind: "self_enforced_input_refusal",
            maximumTokens: verdict.inputTokens,
          },
        ],
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
      return {
        status: "admitted",
        reservationId: reserved.reservationId as string,
        attemptId: reserved.attemptId as string,
        maximumCredits: reserved.maximumCredits as number,
        snapshotVersion: reserved.snapshotVersion as number,
        rateVersion: reserved.rateVersion as number,
        inputTokens: verdict.inputTokens,
        documents: verdict.documents,
      };
    },
  };
}
