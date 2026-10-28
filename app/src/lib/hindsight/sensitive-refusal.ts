/**
 * The sensitivity gate's two refusal sentences, as this app recognizes them (FIX-OCR3 /
 * O3-M4, the F-G1-4 gate's browser half).
 *
 * The server refuses medical/financial/customer material on its first confirm and a
 * credential outright (server/src/hindsight/sensitivity-gate.ts and
 * server/src/memory/sensitivity.ts own the sentences); its message is what `client` puts on
 * the thrown error. Until now the app had no way to answer either: the mutations never sent
 * the second confirmation, so a sensitive confirm/edit was an unconditional dead end — the
 * one case where the correct UX is to ASK AGAIN was the case the UI could not ask.
 *
 * The sentences are restated here (not shared from the server package) because this is the
 * boundary between two packages; both sides' tests pin the same literals, so a drift on
 * either side fails a suite rather than quietly disabling the second confirmation.
 */

/** Sensitive material's first answer: the confirm is the ask, this is the second look. */
export const SENSITIVE_CONFIRMATION_REQUIRED =
  "Medical, financial and customer information is remembered only when you ask for it yourself and confirm a second time.";

/** A credential's answer: final, no second look exists. */
export const CREDENTIAL_REFUSAL =
  "Credentials are never remembered. OpenBot refuses passwords, tokens, passphrases and keys even when asked to remember them.";

/** Whether a failed write was the sensitive gate asking for its second confirmation. */
export function sensitiveConfirmationRefused(error: unknown): boolean {
  return (
    error instanceof Error && error.message === SENSITIVE_CONFIRMATION_REQUIRED
  );
}

/** Whether a failed write was the credential refusal — final, never retryable. */
export function credentialRefused(error: unknown): boolean {
  return error instanceof Error && error.message === CREDENTIAL_REFUSAL;
}

/**
 * The gate's own two sentences, localized when recognized: the raw message is the server's
 * English sentence, and a person should meet the refusal in their own language — with the
 * second-look affordance beside it when one exists (the errors namespace carries both keys).
 */
export function sensitiveRefusalNote(
  error: string | Error | null | undefined,
  t: (key: "hindsight.sensitiveRequired" | "hindsight.credential") => string,
): string | null {
  if (error === null || error === undefined) return null;
  const message = typeof error === "string" ? error : error.message;
  const shape = new Error(message);
  if (sensitiveConfirmationRefused(shape))
    return t("hindsight.sensitiveRequired");
  if (credentialRefused(shape)) return t("hindsight.credential");
  return null;
}
