/**
 * The server-side ceiling cap: a caller-supplied maxOutputTokens cannot
 * reserve more than this per run, so no single request can occupy the
 * entire token space (OCR R10 H1). Adjust per deployment policy.
 */
export const MAXIMUM_RUN_OUTPUT_TOKENS = 8_000_000;

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
  if (
    !Number.isSafeInteger(maximumTokens) ||
    (maximumTokens as number) <= 0 ||
    (maximumTokens as number) > 2_147_483_647
  ) {
    throw new Error("RUN_OUTPUT_CEILING_REQUIRED");
  }
  return Math.min(maximumTokens as number, MAXIMUM_RUN_OUTPUT_TOKENS);
}
