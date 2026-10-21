import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import type { ReservationBoundQuantities } from "./reserve-bound";

/*
 * The rerank pricing boundary (Bifrost 11.3, #298): the dimension mapping, the
 * query+documents counter, and the enablement gate for the rerank capability — the three
 * things that must ALL hold before a rerank model may be admitted, each proved separately
 * because each fails separately. It stands in #296's (11.1) discipline: the same two
 * closed-vocabulary dimensions, the same conservative counter, the same never-a-zero-cost
 * verdict.
 *
 * WHICH DIMENSIONS A RERANK CAN BILL. Upstream rerank pricing is denominated in exactly two
 * kinds of unit — the INPUT side (the tokens of the query and the documents, the content a
 * ranking pass reads) and a FLAT side (per search / per request; some upstreams state that
 * per document). The closed vocabulary's members for those are `input` (USD per input
 * token) and `surcharge_per_request` (USD flat per billed request), so those are the
 * dimensions this module bills — and BOTH sides are mapped, never only one: a ceiling that
 * priced only the tokens would systematically underestimate an upstream that bills per
 * document, and one that priced only a flat call would underestimate a per-token upstream
 * (the ticket's own resume hint). The per-document worst case is what the surcharge
 * quantity certifies: the DOCUMENT COUNT, not 1, exactly the way 11.1 counts a batch's
 * entries for the same reason — a gateway that fans a ranking out internally bills the
 * smallest unit it could bill separately.
 *
 * Everything else the closed vocabulary prices is structurally absent from a rerank call:
 * the response's payload is scores and indices over the request's own documents — there is
 * no field an output-token, reasoning, cache, image or audio price could ever multiply
 * against. That wire-schema fact IS the upstream evidence the ticket's boundEvidence rule
 * names for "the output produces no additional billing dimension" (11.1's vector-output
 * argument, restated for rankings): not a hope about provider behavior, but the absence of
 * the field itself. The quantities this module certifies say so numerically — output &co
 * at 0 — and the tests pin that even a KNOWN non-zero output price contributes nothing to
 * a rerank's ceiling.
 *
 * THE INPUT BOUND, IN THE CHAT COUNTER'S DISCIPLINE (ADR 0001). The provider's tokenizer is
 * authoritative and unavailable, so the count is of SERIALIZED BYTES with calibration
 * constants chosen to sit ABOVE a tokenizer's answer — never below it. The whole request
 * object is serialized: the model name, the query, and every document's FULL text (a
 * document may be a string or an object carrying its text under `text`, the two shapes the
 * rerank wires carry), so a set of N documents cannot smuggle N−1 bodies past the counter —
 * 文档与查询按完整内容计数，不因截断低估. On top of the byte-derived tokens, each document
 * carries a per-entry overhead the same way the chat counter charges a per-message
 * overhead. There is no truncation fitter: a rerank's documents are the payload — dropping
 * one changes the ranking the caller asked for — so the bound is "counted as it will be
 * sent"; if the count exceeds what a hold could cover, admission refuses rather than
 * sending something uncounted.
 *
 * THE VERDICT. `assessRerankEnablement` folds the two halves: every billed dimension known
 * (an exact amount, or explicitly "0" — free is a price) AND the input countable — a string
 * query over a non-empty array of nameable documents. Missing any dimension answers
 * `enabled: false` with the dimension and its unknown reason — never a zero cost, never a
 * silent pass; 03.8's capability filter and 06.2's reserve re-verification read exactly
 * this verdict. The quantities the enabled verdict carries are
 * ReservationBoundQuantities — ready for 06.5's `computeReservationCeiling`, whose loop
 * prices every dimension of the vocabulary against them.
 */

/**
 * The dimensions a rerank call can bill, from the closed vocabulary. A member's price must
 * be KNOWN on the snapshot for the capability to be enabled — unknown is never a zero
 * cost. Any other dimension is structurally unbillable on this wire (see the module
 * comment) and its quantity is certified 0.
 */
export const RERANK_BILLED_DIMENSIONS = [
  "input",
  "surcharge_per_request",
] as const satisfies readonly PriceDimension[];

/**
 * The conservative counter's calibration, in the chat counter's shape (input-bound.ts,
 * ADR 0001): bytes-per-token floor, safety factor above a typical tokenizer, per-document
 * overhead. Exported because the calibration is the contract "conservative" names.
 */
export const RERANK_BYTES_PER_TOKEN_FLOOR = 2;
export const RERANK_SAFETY_FACTOR = 1.25;
export const RERANK_PER_DOCUMENT_OVERHEAD_TOKENS = 4;

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Can this value's billing text be named in full — a string, or an object carrying one. */
function documentTextOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof (entry as { text?: unknown }).text === "string"
  ) {
    return (entry as { text: string }).text;
  }
  return null;
}

/**
 * How many documents the request carries, and whether each one's text can be named in
 * full. `documents` must be a NON-EMPTY array of strings or { text } objects — ranking
 * needs candidates, and a body this module cannot read in full is not one it can certify.
 * Answers null for any other shape: the shape an uncountable input takes, named for the
 * refusal. The query is checked beside this, in the counter and the verdict, because a
 * request with documents but no query is a different refusal than one with no documents.
 */
export function rerankRequestShape(
  params: unknown,
): { documents: number } | null {
  const documents = (params as { documents?: unknown } | null | undefined)
    ?.documents;
  if (!Array.isArray(documents) || documents.length === 0) return null;
  for (const entry of documents) {
    if (documentTextOf(entry) === null) return null;
  }
  return { documents: documents.length };
}

/**
 * The conservative input-token count for one rerank request: the FULL serialized request
 * (the query and every document's complete text included — 批量文档不遗漏), converted from
 * bytes through the calibration floor and safety factor, plus the per-document overhead.
 * Answers null when the request's shape cannot be certified at all: a counter that could
 * be talked into a number for a shape it did not recognize would be a hole in the bound,
 * not a bound.
 */
export function countRerankInputTokens(params: unknown): number | null {
  const request = params as { query?: unknown } | null | undefined;
  if (typeof request?.query !== "string") return null;
  const shape = rerankRequestShape(params);
  if (shape === null) return null;
  const bytes = serializedBytes(params);
  if (bytes === Number.MAX_SAFE_INTEGER) return null;
  const counted =
    Math.ceil(
      (bytes / RERANK_BYTES_PER_TOKEN_FLOOR) * RERANK_SAFETY_FACTOR,
    ) +
    shape.documents * RERANK_PER_DOCUMENT_OVERHEAD_TOKENS;
  return Number.isSafeInteger(counted) ? counted : null;
}

/** Why a rerank capability cannot be enabled. Closed vocabulary, displayable. */
export type RerankEnablementIssue =
  /** A billed dimension's price is unknown on the snapshot — never a zero cost. */
  | {
      code: "rerank_price_unknown";
      dimension: PriceDimension;
      reason: PriceDimensionUnknownReason;
    }
  /** The request's input shape cannot be serialized and counted. */
  | { code: "rerank_input_uncountable"; shape: string };

/** The verdict: enabled carries the certified quantities; refused carries the reason. */
export type RerankEnablement =
  | {
      enabled: true;
      /** True when every billed dimension is priced at exactly "0": free is a price. */
      free: boolean;
      /** The worst-case per-dimension quantities, ready for the ceiling conversion. */
      quantities: ReservationBoundQuantities;
      /** The conservative input-token count the quantities stand on. */
      inputTokens: number;
      /** How many documents were counted — the surcharge quantity's basis. */
      documents: number;
    }
  | { enabled: false; issue: RerankEnablementIssue };

/**
 * The rerank capability's enablement gate (缺维度时不启用): dimensions complete AND the
 * input countable, or refused with the named reason. A dimension priced exactly "0" passes
 * as free — a price — while an unknown dimension never degrades to a zero cost. The shape
 * check runs BEFORE any price is consulted, so an uncountable input never reaches the
 * price table at all.
 */
export function assessRerankEnablement(input: {
  /** The locked price basis's dims (03.2's full map — the rerank subset is read here). */
  dims: PriceSnapshotDims;
  /** The rerank request as it will be sent ({ model, query, documents }). */
  params: unknown;
}): RerankEnablement {
  const request = input.params as
    | { documents?: unknown; query?: unknown }
    | null
    | undefined;
  const shape = rerankRequestShape(input.params);
  if (typeof request?.query !== "string") {
    return {
      enabled: false,
      issue: { code: "rerank_input_uncountable", shape: "query_not_string" },
    };
  }
  if (shape === null) {
    const documents = request?.documents;
    const issue =
      !Array.isArray(documents)
        ? "documents_not_array"
        : documents.length === 0
          ? "documents_empty"
          : "document_text_not_nameable";
    return {
      enabled: false,
      issue: { code: "rerank_input_uncountable", shape: issue },
    };
  }
  const inputTokens = countRerankInputTokens(input.params);
  if (inputTokens === null) {
    // Unreachable behind the shape check; kept so the counter's own refusal can never be
    // priced past.
    return {
      enabled: false,
      issue: { code: "rerank_input_uncountable", shape: "input_not_serializable" },
    };
  }

  // The billed dimensions must each be known. The first unknown one answers — closed
  // precedence, input before surcharge, so two missing dimensions name the one a caller
  // can act on first.
  for (const dimension of RERANK_BILLED_DIMENSIONS) {
    const state = input.dims[dimension];
    if (state.status === "unknown") {
      return {
        enabled: false,
        issue: {
          code: "rerank_price_unknown",
          dimension,
          reason: state.reason,
        },
      };
    }
  }

  const free = RERANK_BILLED_DIMENSIONS.every(
    (dimension) =>
      input.dims[dimension].status === "known" &&
      input.dims[dimension].amount === "0",
  );

  // The certified worst-case quantities, one per dimension of the closed vocabulary:
  // the counted input tokens, the per-document surcharge, and 0 for every dimension the
  // rerank wire cannot bill (the rankings-output evidence, stated numerically).
  const quantities = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "input"
        ? inputTokens
        : dimension === "surcharge_per_request"
          ? shape.documents
          : 0,
    ]),
  ) as ReservationBoundQuantities;

  return {
    enabled: true,
    free,
    quantities,
    inputTokens,
    documents: shape.documents,
  };
}
