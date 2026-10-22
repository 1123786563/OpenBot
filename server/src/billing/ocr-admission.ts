import type { ModelRef } from "../gateway/catalog";
import type { ConversionRate } from "../gateway/conversion-rate";
import {
  assessOcrEnablement,
  type OcrEnablementIssue,
  type OcrRequestShape,
} from "./ocr-pricing";
import type { PayerRef } from "./payer";
import type { ReservationCeilingIssue } from "./reserve-bound";
import { computeReservationCeiling } from "./reserve-bound";

/*
 * The OCR admission door (Bifrost 11.6, #301): the entry an OCR dispatch lands on — 11.5's
 * enablement verdict wired in FIRST, so a request whose basis leaves any billed dimension
 * unknown is refused at the entry, before any reserve call and before any provider could be
 * reached (未知不得当作免费执行).
 *
 * THE SHORT-CIRCUIT IS THE POINT. `price_unknown` — upstream silence about a dimension an
 * OCR call bills (the output side above all: 11.5 pinned that a v1 basis without a
 * completion price leaves output unknown, never free) — refuses with the dimension and its
 * per-dimension reason, and the door is never called: no hold forms, no ledger row lands,
 * and a hold is the dispatch commitment, so the provider-side proof (调用数为 0) starts from
 * an account that provably never committed to the call (拒绝路径不产生任何账务写入). The
 * same short-circuit answers the input-bound refusals (页数不可定 never an estimate,
 * ADR 0001) and the uncapped-output refusal (Q11: cannot enforce → not enabled).
 *
 * FREE IS A PRICE, AND IT IS EXECUTABLE — but only when the BASIS says so: every billed
 * dimension priced exactly "0" (明确免费), never a missing dimension's default. The free
 * verdict dispatches without a hold — zero cost is priced, and a hold of zero is not a hold
 * — and the answer says `free` in its own word, so no surface can render it as unknown or
 * unknown as free (明确免费可与未知区分). Authorization is NOT this door's to grant: the
 * caller's own gates (auth, 门禁) stay in front of the dispatch exactly as for paid work.
 *
 * PAID WORK MEANS HELD WORK. A priced verdict certifies its ceiling through 06.5's own
 * conversion over the LOCKED basis and sends ONE reserve request whose bound evidence is
 * the OCR call's honest self-enforcement: the output-token cap the caller attests
 * (`provider_max_tokens`, 14.1's own rule for a text output the wire cannot bound itself),
 * and the page/image count the request itself pins (`self_enforced_input_refusal` — the
 * entries are the payload; truncation would change the answer). The door's own refusals
 * (grant, freshness, balance — the seven verdicts) pass through untouched.
 *
 * WHO CALLS THIS. The deployment's OCR entrypoint — the counterpart of the chat path's
 * admission composition — with the production reserve being 06.2's CreditReserveService.
 * The reserve caller and the dispatch are injected so the wiring stays the same seam in
 * tests, and so this module itself never touches a database: the money paths stay where
 * they already live.
 */

/** Why the entry refused, in the entry's own closed stages. Displayable on any surface. */
export type OcrAdmissionRefusal =
  | {
      status: "refused";
      /** 11.5's verdict refused before the door was reached (the short-circuit). */
      stage: "enablement";
      reasonCode: OcrEnablementIssue["code"];
      /** The verdict's own detail: the dimension + reason, the shape, or the cap. */
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** The ceiling conversion could not certify a hold over the enabled verdict. */
      stage: "ceiling";
      reasonCode: ReservationCeilingIssue["code"];
      detail: Record<string, unknown>;
    }
  | {
      status: "refused";
      /** The reserve door refused — the door's own reason codes pass through unchanged. */
      stage: "reserve";
      reasonCode: string;
      detail: Record<string, unknown>;
    };

/** The free answer: priced at exactly zero, executable, hold-free — a word of its own. */
export type OcrAdmissionFree = {
  status: "free";
  /** The per-dimension quantities the verdict certified (all priced zero). */
  quantities: Record<string, number>;
  /** The billing shape the free verdict stood on. */
  shape: OcrRequestShape;
};

/** The admitted answer: what the hold carries, ready for dispatch and settlement. */
export type OcrAdmission = {
  status: "admitted";
  reservationId: string;
  attemptId: string;
  /** The certified ceiling the hold locked — never below the exact worst case. */
  maximumCredits: number;
  snapshotVersion: number;
  rateVersion: number;
};

export type OcrAdmissionOutcome =
  | OcrAdmission
  | OcrAdmissionFree
  | OcrAdmissionRefusal;

/** The seams the entry composes — production wires 06.2 and the provider dispatch. */
export type OcrAdmissionDependencies = {
  /** The reserve door: 06.2's CreditReserveService in production. */
  reserve: (request: unknown) => Promise<{
    status: "reserved" | "refused";
    [field: string]: unknown;
  }>;
  /**
   * The provider dispatch: called at most once, only after a hold exists (or the basis is
   * priced exactly free) — the seam the provider-call-count proofs read.
   */
  dispatch: (input: {
    model: ModelRef;
    reservationId?: string;
    free: boolean;
  }) => Promise<unknown>;
};

/** One admission request: the wire request's identity plus the locked basis it prices against. */
export type OcrAdmissionInput = {
  /** The OCR request as it will be sent ({ model, document, params }). */
  request: unknown;
  /** The authorization the dispatch runs under — the reserve door re-proves it live. */
  grantId: string;
  /** The payment account claim — a claim; the door resolves the account server-side. */
  payer: PayerRef;
  /** The OCR model cell being admitted. */
  model: ModelRef;
  /** The price basis version the request locks. */
  snapshotVersion: number;
  /** The conversion-rate version the request locks. */
  rateVersion: number;
  /** The locked basis's dims — the same version the reserve request will name. */
  dims: Parameters<typeof computeReservationCeiling>[0]["dims"];
  /** The locked USD→credits conversion rate. */
  rate: ConversionRate;
  /** The enforceable output-token cap (provider param or local bound). */
  outputTokenCap: number;
  /** The caller's retry identity; a replay answers the original reservation. */
  idempotencyKey: string;
};

/**
 * Wire the OCR entry: enablement short-circuit, free-vs-unknown distinction, ceiling
 * certification, one reserve request, dispatch only over a hold (or an exactly-free basis).
 * A refusal at any stage answers with that stage's own reason and leaves the account
 * exactly as it was — the entry never writes anything itself.
 */
export function createOcrAdmission(dependencies: OcrAdmissionDependencies) {
  return {
    async admit(input: OcrAdmissionInput): Promise<OcrAdmissionOutcome> {
      // 1. The enablement verdict, first and cheapest: shape before pages, pages before
      //    cap, cap before prices. A refusal here never reaches the reserve at all — and
      //    an UNKNOWN dimension refuses, it is never a zero cost.
      const verdict = assessOcrEnablement({
        dims: input.dims,
        params: input.request,
        outputTokenCap: input.outputTokenCap,
      });
      if (!verdict.enabled) {
        const issue = verdict.issue;
        return {
          status: "refused",
          stage: "enablement",
          reasonCode: issue.code,
          detail:
            issue.code === "price_unknown"
              ? { dimension: issue.dimension, reason: issue.reason }
              : "shape" in issue
                ? { shape: issue.shape }
                : {},
        };
      }

      // 2. Free is a price: every billed dimension priced exactly "0" — the basis's own
      //    evidence, never a missing dimension's default. Free dispatches without a hold
      //    (zero cost is priced; a zero hold is not a hold), under the caller's own
      //    authorization gates, in its own word so no surface can conflate it with unknown.
      if (verdict.free) {
        await dependencies.dispatch({ model: input.model, free: true });
        return {
          status: "free",
          quantities: verdict.quantities,
          shape: verdict.shape,
        };
      }

      // 3. The ceiling over the SAME locked basis — 06.5's own conversion, pricing every
      //    dimension of the vocabulary against the verdict's certified quantities. (The
      //    enablement verdict above already ran, so this is the conversion alone.)
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

      // 4. One reserve request, exactly the door's contract: the attested output cap
      //    (provider-enforced or locally bounded — the mechanism the caller attests), the
      //    pinned entry count refused over rather than truncated (the pages are the
      //    payload), the certified maximum, the locked versions.
      const reserved = await dependencies.reserve({
        grantId: input.grantId,
        payer: input.payer,
        model: input.model,
        snapshotVersion: input.snapshotVersion,
        rateVersion: input.rateVersion,
        boundEvidence: [
          { kind: "provider_max_tokens", maximumTokens: input.outputTokenCap },
          {
            kind: "self_enforced_input_refusal",
            maximumTokens:
              verdict.shape.kind === "document" ? verdict.shape.pages : 1,
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

      // 5. Dispatch only over the hold — the commitment the provider call bills to.
      await dependencies.dispatch({
        model: input.model,
        reservationId: reserved.reservationId as string,
        free: false,
      });
      return {
        status: "admitted",
        reservationId: reserved.reservationId as string,
        attemptId: reserved.attemptId as string,
        maximumCredits: reserved.maximumCredits as number,
        snapshotVersion: reserved.snapshotVersion as number,
        rateVersion: reserved.rateVersion as number,
      };
    },
  };
}
