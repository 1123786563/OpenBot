import {
  PRICE_DIMENSIONS,
  type PriceDimension,
  type PriceDimensionUnknownReason,
  type PriceSnapshotDims,
} from "../gateway/price-snapshot";
import type { ReservationBoundQuantities } from "./reserve-bound";

/*
 * The embedding pricing boundary (Bifrost 11.1, #296): the dimension mapping, the input
 * bound, and the enablement verdict for the /v1/embeddings capability — the three things
 * that must ALL hold before an embedding model may be admitted, each proved separately
 * because each fails separately.
 *
 * WHICH DIMENSIONS AN EMBEDDING CAN BILL. The v1 embeddings wire bills exactly two: the
 * input tokens (`pricing.prompt` — the request's entries, tokenized by the provider) and
 * the flat per-request surcharge (`pricing.request`). Everything else the closed vocabulary
 * prices is structurally absent from an embeddings call: the OUTPUT is a vector, and the
 * v1 response's usage carries `prompt_tokens` and `total_tokens` only — there is no field
 * an output-token, reasoning, cache, image or audio price could ever multiply against.
 * That wire-schema fact IS the upstream evidence the ticket's boundEvidence rule names for
 * "the output is a vector and produces no additional billing dimension": not a hope about
 * provider behavior, but the absence of the field itself, on the protocol both sides
 * implement. The quantities this module certifies say so numerically — output &co at 0 —
 * and the tests pin that even a KNOWN non-zero output price contributes nothing to an
 * embedding's ceiling.
 *
 * MODEL VARIANTS ARE MODEL CELLS. text-embedding-3-small vs -large, 1536 vs 3072 output
 * dimensions, quantized variants: each is its own catalog ref with its own snapshot
 * (03.1/03.2) — a variant is never a discount dimension of another model, so nothing here
 * tries to derive one cell's price from another's.
 *
 * THE INPUT BOUND, IN THE CHAT COUNTER'S DISCIPLINE (ADR 0001). The provider's tokenizer
 * is authoritative and unavailable, so the count is of SERIALIZED BYTES with calibration
 * constants chosen to sit ABOVE a tokenizer's answer — never below it. The whole request
 * object is serialized: the model name, the encoding, and every batch entry's FULL text,
 * so a batch of N entries cannot smuggle N−1 entries past the counter. On top of the
 * byte-derived tokens, each entry carries a per-entry overhead the same way the chat
 * counter charges a per-message overhead. Unlike chat there is NO truncation fitter: an
 * embeddings request's entries are the payload — dropping one changes the answer the
 * caller asked for — so the bound is not "truncated to fit" but "counted as it will be
 * sent"; if the count exceeds what a hold could cover, admission refuses rather than
 * sending something uncounted.
 *
 * THE PER-ENTRY SURCHARGE, COUNTED PER ENTRY. The wire prices `request` flat per billed
 * request, and a batch entry is the smallest unit a provider could bill separately (some
 * gateways fan a batch out internally). The worst case a ceiling must cover is N entries
 * × the flat price, so the certified quantity for `surcharge_per_request` is the ENTRY
 * count, not 1 — conservative in the only direction strict billing allows.
 *
 * THE VERDICT. `assessEmbeddingEnablement` folds the two halves: every billed dimension
 * known (an exact amount, or explicitly "0" — free is a price) AND the input countable.
 * Missing any dimension answers `enabled: false` with the dimension and its unknown
 * reason — never a zero cost, never a silent pass (AC4); 03.8's capability filter and
 * 06.2's reserve re-verification read exactly this verdict. The quantities the enabled
 * verdict carries are ReservationBoundQuantities — ready for 06.5's
 * `computeReservationCeiling`, whose loop prices every dimension of the vocabulary
 * against them.
 */

/**
 * The dimensions an embeddings call can bill, from the closed vocabulary. A member's
 * price must be KNOWN on the snapshot for the capability to be enabled — unknown is
 * never a zero cost. Any other dimension is structurally unbillable on this wire (see
 * the module comment) and its quantity is certified 0.
 */
export const EMBEDDING_BILLED_DIMENSIONS = [
  "input",
  "surcharge_per_request",
] as const satisfies readonly PriceDimension[];

/**
 * The conservative counter's calibration, in the chat counter's shape (input-bound.ts,
 * ADR 0001): bytes-per-token floor, safety factor above a typical tokenizer, per-entry
 * overhead. Exported because the calibration is the contract "conservative" names.
 */
export const EMBEDDING_BYTES_PER_TOKEN_FLOOR = 2;
export const EMBEDDING_SAFETY_FACTOR = 1.25;
export const EMBEDDING_PER_ENTRY_OVERHEAD_TOKENS = 4;

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * How many batch entries the request carries: `input` as a string is one entry; as an
 * array, its length (each member one entry — a text or a pre-tokenized token array);
 * anything else is not an embeddings input this module can certify, and answers null —
 * the shape an uncountable input takes, named for the refusal.
 */
export function embeddingEntryCount(
  params: unknown,
): { entries: number; shape: "string" | "array" } | null {
  const input = (params as { input?: unknown } | null | undefined)?.input;
  if (typeof input === "string") {
    return { entries: 1, shape: "string" };
  }
  if (Array.isArray(input)) {
    return { entries: input.length, shape: "array" };
  }
  return null;
}

/**
 * The conservative input-token count for one embeddings request: the FULL serialized
 * request (every batch entry's complete text included — 批量条目不遗漏), converted from
 * bytes through the calibration floor and safety factor, plus the per-entry overhead.
 * Answers null when the input's shape cannot be certified at all: a counter that could
 * be talked into a number for a shape it did not recognize would be a hole in the bound,
 * not a bound.
 */
export function countEmbeddingInputTokens(params: unknown): number | null {
  const entry = embeddingEntryCount(params);
  if (entry === null) return null;
  const bytes = serializedBytes(params);
  if (bytes === Number.MAX_SAFE_INTEGER) return null;
  const counted =
    Math.ceil(
      (bytes / EMBEDDING_BYTES_PER_TOKEN_FLOOR) * EMBEDDING_SAFETY_FACTOR,
    ) +
    entry.entries * EMBEDDING_PER_ENTRY_OVERHEAD_TOKENS;
  return Number.isSafeInteger(counted) ? counted : null;
}

/** Why an embedding capability cannot be enabled. Closed vocabulary, displayable. */
export type EmbeddingEnablementIssue =
  /** A billed dimension's price is unknown on the snapshot — never a zero cost. */
  | {
      code: "embedding_price_unknown";
      dimension: PriceDimension;
      reason: PriceDimensionUnknownReason;
    }
  /** The request's input shape cannot be serialized and counted. */
  | { code: "embedding_input_uncountable"; shape: string };

/** The verdict: enabled carries the certified quantities; refused carries the reason. */
export type EmbeddingEnablement =
  | {
      enabled: true;
      /** True when every billed dimension is priced at exactly "0": free is a price. */
      free: boolean;
      /** The worst-case per-dimension quantities, ready for the ceiling conversion. */
      quantities: ReservationBoundQuantities;
      /** The conservative input-token count the quantities stand on. */
      inputTokens: number;
      /** How many batch entries were counted — the surcharge quantity's basis. */
      entries: number;
    }
  | { enabled: false; issue: EmbeddingEnablementIssue };

/**
 * The embedding capability's enablement predicate (AC3/AC4): dimensions complete AND the
 * input countable, or refused with the named reason. A dimension priced exactly "0"
 * passes as free — a price — while an unknown dimension never degrades to a zero cost.
 */
export function assessEmbeddingEnablement(input: {
  /** The locked price basis's dims (03.2's full map — the embedding subset is read here). */
  dims: PriceSnapshotDims;
  /** The embeddings request as it will be sent. */
  params: unknown;
}): EmbeddingEnablement {
  const entry = embeddingEntryCount(input.params);
  if (entry === null) {
    return {
      enabled: false,
      issue: {
        code: "embedding_input_uncountable",
        shape: "input_not_string_or_array",
      },
    };
  }
  const inputTokens = countEmbeddingInputTokens(input.params);
  if (inputTokens === null) {
    return {
      enabled: false,
      issue: {
        code: "embedding_input_uncountable",
        shape: "input_not_serializable",
      },
    };
  }

  // The billed dimensions must each be known. The first unknown one answers — closed
  // precedence, input before surcharge, so two missing dimensions name the one a caller
  // can act on first.
  for (const dimension of EMBEDDING_BILLED_DIMENSIONS) {
    const state = input.dims[dimension];
    if (state.status === "unknown") {
      return {
        enabled: false,
        issue: {
          code: "embedding_price_unknown",
          dimension,
          reason: state.reason,
        },
      };
    }
  }

  const free = EMBEDDING_BILLED_DIMENSIONS.every(
    (dimension) =>
      input.dims[dimension].status === "known" &&
      input.dims[dimension].amount === "0",
  );

  // The certified worst-case quantities, one per dimension of the closed vocabulary:
  // the counted input tokens, the per-entry surcharge, and 0 for every dimension the
  // embeddings wire cannot bill (the vector-output evidence, stated numerically).
  const quantities = Object.fromEntries(
    PRICE_DIMENSIONS.map((dimension) => [
      dimension,
      dimension === "input"
        ? inputTokens
        : dimension === "surcharge_per_request"
          ? entry.entries
          : 0,
    ]),
  ) as ReservationBoundQuantities;

  return {
    enabled: true,
    free,
    quantities,
    inputTokens,
    entries: entry.entries,
  };
}
