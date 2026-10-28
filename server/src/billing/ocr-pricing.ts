import type { ConversionRate } from "../gateway/conversion-rate";
import {
  canonicalPriceAmount,
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import {
  computeReservationCeiling,
  type ReservationBoundQuantities,
  type ReservationCeilingIssue,
} from "./reserve-bound";

/*
 * The OCR pricing boundary (Bifrost 11.5, #300): the dimension mapping, the pre-dispatch
 * page determination, and the enablement verdict for the /v1/ocr capability — the three
 * things that must ALL hold before an OCR model may be admitted, each proved separately
 * because each fails separately. It stands in 11.1's and 14.1's discipline: the same
 * closed-vocabulary dimensions, the same "determinable before dispatch or refused" input
 * bound, the same never-a-zero-cost verdict.
 *
 * WHICH DIMENSIONS AN OCR CALL BILLS. Upstream OCR pricing is denominated in exactly three
 * kinds of unit (the ticket's own mapping): PAGES, IMAGES, and OUTPUT TOKENS. On the wire
 * each rides a real member of the closed vocabulary: the per-page price is the gateway's
 * own flat field — BifrostCost's InputCostDetails.RequestCost "is a flat per-request
 * surcharge (also OCR per-page…)", core/schemas/chatcompletions.go — so the flat dimension
 * (`surcharge_per_request`) carries it, and the smallest unit a provider could bill
 * separately is the PAGE, exactly the way 11.1 certified a batch's ENTRY count (not 1) as
 * the flat side's quantity; the per-image price rides `image` (USD per input image); the
 * per-output-token price rides `output`. Everything else the closed vocabulary prices is
 * structurally absent from an OCR call: the response's pages carry markdown text and image
 * bounding boxes, and its usage_info carries pages_processed and doc_size_bytes only — no
 * field an input-token, reasoning, cache or audio price could ever multiply against. That
 * wire-schema fact is the upstream evidence the family's boundEvidence rule names: not a
 * hope about provider behavior, but the absence of the field itself. The quantities this
 * module certifies say so numerically — input &co at 0 — and the tests pin that even a
 * KNOWN non-zero input price contributes nothing to an OCR ceiling.
 *
 * THE INPUT BOUND: THE PAGES MUST BE PINNED BEFORE DISPATCH. A document OCR bills per page,
 * and the page count is only determinable from the request itself when the request PINS it:
 * the wire's own `params.pages` selection (OCRParameters.Pages, the pages the provider will
 * actually process). A document_url without a page selection names a document whose page
 * count lives inside the bytes — server-side PDF parsing is an estimate's clothing, and an
 * estimate is not a bound (ADR 0001) — so it answers `ocr_pages_indeterminable` (页数在派发
 * 前不可知时必须判为证据不足而不是按估算预留, the ticket's own resume hint). With a
 * selection present, the certified count is the ENTRIES AS SENT, duplicates included: the
 * worst case a ceiling must cover is every page the request names (多页请求的上限覆盖全部
 * 页), and a provider that re-processes a twice-named page bills it twice. An image
 * document (`image_url`) is determinable on its face: one image, billed once on `image` —
 * and once on the flat side too, because a flat field priced per page still bills ONE unit
 * for a one-image request, and a ceiling that certified 0 for a side the wire can bill is a
 * hole, not a bound.
 *
 * THE OUTPUT SIDE NEEDS A CAP THE CALL CAN ENFORCE. OCR output is generated markdown whose
 * token count the wire cannot cap (no max_tokens on /v1/ocr), so the cap arrives as
 * EVIDENCE the caller attests — 14.1's own rule for a text output the request cannot bound
 * itself. No cap, or a non-positive one, refuses the call method (Q11: cannot enforce →
 * not enabled); an output price the basis leaves `unknown` refuses the enablement the same
 * way every billed dimension does — upstream silence about output tokens is never a claim
 * they are free, so 11.6's entrance refuses rather than executing at zero cost.
 *
 * THE VERDICT. `assessOcrEnablement` folds the halves: shape before pages, pages before
 * cap, cap before prices — a closed precedence so two missing facts name the one a caller
 * can act on first. The quantities the enabled verdict carries are
 * ReservationBoundQuantities — ready for 06.5's `computeReservationCeiling`, whose loop
 * prices every dimension of the vocabulary against them (`ocrCeiling`, the same exact
 * arithmetic admission uses).
 */

/**
 * The dimensions an OCR call bills, from the closed vocabulary: the flat side carrying the
 * per-page price, the per-image side, and the output-token side. A member's price must be
 * KNOWN on the snapshot for the capability to be enabled — unknown is never a zero cost.
 * Any other dimension is structurally unbillable on this wire (see the module comment) and
 * its quantity is certified 0.
 */
export const OCR_BILLED_DIMENSIONS = [
  "surcharge_per_request",
  "image",
  "output",
] as const satisfies readonly PriceDimension[];

/**
 * The billing shape of one OCR request, as the request's own document type selects it: a
 * `document_url` bills pages (the count the request must pin), an `image_url` bills one
 * image.
 */
export type OcrRequestShape =
  | { kind: "document"; pages: number }
  | { kind: "image" };

/** Why the shape could not be certified. Closed vocabulary, for the refusal's detail. */
export type OcrShapeIssue =
  | "document_type_missing"
  | "document_type_unknown"
  | "document_url_missing"
  | "image_url_missing"
  | "pages_not_pinned"
  | "pages_not_positive_integers";

/**
 * Read one OCR request's billing shape: the document's declared type (the wire's own
 * selector, validated by the pinned gateway's own prepareOCRRequest the same way), and —
 * for a document — the page selection that pins the count before dispatch. The count is
 * the entries AS SENT, duplicates included: every page the request names is a page the
 * provider may process and bill, and the ceiling must cover all of them. A shape this
 * function cannot certify answers with the closed issue that names why.
 */
export function ocrRequestShape(
  params: unknown,
): { ok: true; shape: OcrRequestShape } | { ok: false; issue: OcrShapeIssue } {
  const document = (params as { document?: unknown } | null | undefined)
    ?.document;
  if (document === null || typeof document !== "object") {
    return { ok: false, issue: "document_type_missing" };
  }
  const typed = document as {
    type?: unknown;
    document_url?: unknown;
    image_url?: unknown;
  };
  if (typeof typed.type !== "string" || typed.type === "") {
    return { ok: false, issue: "document_type_missing" };
  }
  if (typed.type === "document_url") {
    if (typeof typed.document_url !== "string" || typed.document_url === "") {
      return { ok: false, issue: "document_url_missing" };
    }
    const pages = (params as { params?: unknown } | null | undefined)?.params as
      | { pages?: unknown }
      | null
      | undefined;
    const selection = pages?.pages;
    if (!Array.isArray(selection) || selection.length === 0) {
      return { ok: false, issue: "pages_not_pinned" };
    }
    for (const page of selection) {
      if (
        typeof page !== "number" ||
        !Number.isSafeInteger(page) ||
        page <= 0
      ) {
        return { ok: false, issue: "pages_not_positive_integers" };
      }
    }
    return { ok: true, shape: { kind: "document", pages: selection.length } };
  }
  if (typed.type === "image_url") {
    if (typeof typed.image_url !== "string" || typed.image_url === "") {
      return { ok: false, issue: "image_url_missing" };
    }
    return { ok: true, shape: { kind: "image" } };
  }
  return { ok: false, issue: "document_type_unknown" };
}

/**
 * Why an OCR capability cannot be enabled. Closed vocabulary, displayable.
 */
export type OcrEnablementIssue =
  /** The request's shape cannot be read as an OCR request this module can certify. */
  | { code: "ocr_request_unreadable"; shape: OcrShapeIssue }
  /** The document's page count is not pinned by the request (证据不足, never an estimate). */
  | { code: "ocr_pages_indeterminable"; shape: OcrShapeIssue }
  /** No enforceable output-token cap (Q11: cannot enforce → not enabled). */
  | { code: "ocr_output_uncapped" }
  /** A billed dimension's price is unknown on the basis — never a zero cost. */
  | {
      code: "price_unknown";
      dimension: PriceDimension;
      reason: PriceDimensionUnknownReason;
    };

/** The verdict: enabled carries the certified quantities; refused carries the reason. */
export type OcrEnablement =
  | {
      enabled: true;
      /** True when every billed dimension is priced at exactly "0": free is a price. */
      free: boolean;
      /** The per-dimension quantities, ready for 06.5's conversion. */
      quantities: ReservationBoundQuantities;
      /** The billing shape the quantities stand on. */
      shape: OcrRequestShape;
      /** The enforceable output-token cap the caller attested. */
      outputTokenCap: number;
    }
  | { enabled: false; issue: OcrEnablementIssue };

/**
 * The OCR capability's enablement predicate (AC1–AC4): the shape readable, the pages
 * pinned, the output capped by attested evidence, and every billed dimension priced on the
 * locked basis — or refused with the named reason. A dimension priced exactly "0" passes as
 * free — a price — while an unknown dimension never degrades to a zero cost. The dims handed
 * in are the LOCKED basis's; this function never reads a price of its own.
 */
export function assessOcrEnablement(input: {
  dims: PriceSnapshotDims;
  /** The OCR request as it will be sent ({ model, document, params }). */
  params: unknown;
  /** The enforceable output-token cap (provider param or local bound). */
  outputTokenCap: number;
}): OcrEnablement {
  const shapeRead = ocrRequestShape(input.params);
  if (!shapeRead.ok) {
    const isPagesIssue =
      shapeRead.issue === "pages_not_pinned" ||
      shapeRead.issue === "pages_not_positive_integers";
    return {
      enabled: false,
      issue: {
        code: isPagesIssue
          ? "ocr_pages_indeterminable"
          : "ocr_request_unreadable",
        shape: shapeRead.issue,
      },
    };
  }
  const shape = shapeRead.shape;
  if (
    !Number.isSafeInteger(input.outputTokenCap) ||
    input.outputTokenCap <= 0
  ) {
    return { enabled: false, issue: { code: "ocr_output_uncapped" } };
  }
  for (const dimension of OCR_BILLED_DIMENSIONS) {
    const state = input.dims[dimension];
    if (state.status === "unknown") {
      return {
        enabled: false,
        issue: {
          code: "price_unknown",
          dimension,
          reason: state.reason,
        },
      };
    }
  }

  const free = OCR_BILLED_DIMENSIONS.every((dimension) => {
    const state = input.dims[dimension];
    if (state.status !== "known") return false;
    const canonical = canonicalPriceAmount(state.amount);
    return canonical.ok && canonical.amount === "0";
  });

  // The certified worst-case quantities, one per dimension of the closed vocabulary: the
  // page count on the flat side for a document (every page the request names), one unit on
  // each of the flat and image sides for an image document, the attested cap on the output
  // side, and 0 for every dimension the OCR wire cannot bill (the usage-schema evidence,
  // stated numerically).
  const quantities = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => {
      let quantity = 0;
      if (dimension === "surcharge_per_request") {
        quantity = shape.kind === "document" ? shape.pages : 1;
      } else if (dimension === "image") {
        quantity = shape.kind === "image" ? 1 : 0;
      } else if (dimension === "output") {
        quantity = input.outputTokenCap;
      }
      return [dimension, quantity];
    }),
  ) as ReservationBoundQuantities;

  return {
    enabled: true,
    free,
    quantities,
    shape,
    outputTokenCap: input.outputTokenCap,
  };
}

/**
 * The hold ceiling: the pinned pages, the image unit and the attested cap priced through
 * 06.5's own exact conversion over the LOCKED basis — the same arithmetic admission uses,
 * so a hold and everything downstream can never disagree about what the same input costs.
 */
export function ocrCeiling(input: {
  dims: PriceSnapshotDims;
  params: unknown;
  outputTokenCap: number;
  rate: ConversionRate;
}):
  | {
      ok: true;
      maximumCredits: number;
      exactScaledUnits: { numerator: bigint; denominator: bigint };
    }
  | { ok: false; issue: OcrEnablementIssue | ReservationCeilingIssue } {
  const verdict = assessOcrEnablement({
    dims: input.dims,
    params: input.params,
    outputTokenCap: input.outputTokenCap,
  });
  if (!verdict.enabled) {
    return { ok: false, issue: verdict.issue };
  }
  const priced = computeReservationCeiling({
    dims: input.dims,
    quantities: verdict.quantities,
    rate: input.rate,
  });
  return priced;
}
