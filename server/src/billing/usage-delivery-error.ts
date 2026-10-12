/** A delivery attempt that did not succeed; the code is a stable word, never provider text. */
export class UsageDeliveryError extends Error {
  override name = "UsageDeliveryError";

  constructor(readonly code: string) {
    super(`Usage delivery failed (${code}).`);
  }
}
