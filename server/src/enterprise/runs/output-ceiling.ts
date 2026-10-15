/**
 * The server-side ceiling cap: a caller-supplied maxOutputTokens cannot
 * reserve more than this per run, so no single request can occupy the
 * entire token space (OCR R10 H1). Adjust per deployment policy.
 */
export const MAXIMUM_RUN_OUTPUT_TOKENS = 8_000_000;

/**
 * A positive token count that fits the PostgreSQL int4 column every token
 * limit shares (model_route_maximum_tokens et al.). One predicate so a future
 * widening (say, to bigint) cannot miss a copy.
 */
export function isPositiveInt32TokenCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2_147_483_647
  );
}

export function runOutputCeilingFromInput(input: unknown): number {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("RUN_OUTPUT_CEILING_REQUIRED");
  }
  const forwardedProps = (input as { forwardedProps?: unknown }).forwardedProps;
  if (
    !forwardedProps ||
    typeof forwardedProps !== "object" ||
    Array.isArray(forwardedProps)
  ) {
    throw new Error("RUN_OUTPUT_CEILING_REQUIRED");
  }
  const maximumTokens = (forwardedProps as { maxOutputTokens?: unknown })
    .maxOutputTokens;
  if (!isPositiveInt32TokenCount(maximumTokens)) {
    throw new Error("RUN_OUTPUT_CEILING_REQUIRED");
  }
  return Math.min(maximumTokens, MAXIMUM_RUN_OUTPUT_TOKENS);
}
