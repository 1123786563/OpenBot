/**
 * The chain-side sensitivity gate (audit F-G1-4).
 *
 * The personal-memory store has always classified what it stores; the Hindsight chain's
 * confirm/retain seams had no such gate, so wiring their write paths would have opened the
 * back door the store refuses. This module is the one gate every chain confirm/edit path
 * calls — it reuses the same classifier (`../memory/sensitivity.ts`), so the two surfaces
 * cannot drift apart on what counts as a credential, a diagnosis or somebody else's data.
 *
 * Two rules, in the order the store applies them:
 *
 *   - A credential is NEVER remembered. The refusal lands before any authority row, work row
 *     or remote call exists, and its message is the store's fixed sentence — never the
 *     content — so a refused secret is not echoed into a response, an audit payload or a log.
 *   - Medical, financial and customer material is remembered only on the person's explicit
 *     second confirmation: the confirm is the ask, and `confirmSensitive: true` is the
 *     second look at what is about to be kept. Anything else about the content is ordinary
 *     and learns without ceremony, exactly as the store's own rule.
 *
 * Reached only from trusted callers (the seams resolve a trusted scope first), and the
 * thrown error carries the CLASS, never the content.
 */

import {
  CREDENTIAL_REFUSAL,
  classifyMemorySensitivity,
  type SensitivityClass,
} from "../memory/sensitivity";

/** A content class the chain refuses to store without the caller's second confirmation. */
export class MemorySensitivityRefusedError extends Error {
  constructor(
    readonly sensitivity: SensitivityClass,
    message: string,
  ) {
    super(message);
    this.name = "MemorySensitivityRefusedError";
  }
}

/** Said to the person when sensitive material arrives without its second confirmation. */
export const SENSITIVE_CONFIRMATION_REQUIRED =
  "Medical, financial and customer information is remembered only when you ask for it yourself and confirm a second time.";

/**
 * The one input field that carries the second confirmation. A boolean, and only the literal
 * `true` counts: a truthy string or a 1 is a caller that did not mean it.
 */
export const SENSITIVE_CONFIRMATION_FIELD = "confirmSensitive";

/**
 * Refuse what the chain may not store. Called with the parsed content and the caller's
 * `confirmSensitive` value; throws `MemorySensitivityRefusedError` before anything is written.
 */
export function assertMemoryContentAdmissible(
  content: string,
  confirmSensitive: unknown,
): void {
  const sensitivity = classifyMemorySensitivity(content);
  if (sensitivity === "credential")
    throw new MemorySensitivityRefusedError(sensitivity, CREDENTIAL_REFUSAL);
  if (sensitivity !== "normal" && confirmSensitive !== true)
    throw new MemorySensitivityRefusedError(
      sensitivity,
      SENSITIVE_CONFIRMATION_REQUIRED,
    );
}
