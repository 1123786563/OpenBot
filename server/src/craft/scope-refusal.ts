/**
 * #618: recognize the fail-closed execution-scope refusal in whatever shape a route's
 * catch meets it — the error class itself, or (the archive walk's fold) a
 * WorkspaceListingError whose message embeds the cause's fixed sentence. Born in
 * file-routes.ts for the upload/archive/delete faces (R1-F2/r3) and hoisted here when
 * FR-F1 brought the session-lifecycle entrances (create/snapshot/restore) to the same
 * recognizer, so every craft face answers the one sentence the same way.
 */
import type { Context } from "hono";
import { WorkspaceListingError } from "./directory-archive";
import { SandboxExecutionScopeUnavailableError } from "./errors";

const SANDBOX_SCOPE_REFUSAL = new SandboxExecutionScopeUnavailableError();

export function sandboxScopeRefusalOf(
  error: unknown,
): SandboxExecutionScopeUnavailableError | null {
  if (error instanceof SandboxExecutionScopeUnavailableError) return error;
  if (
    error instanceof WorkspaceListingError &&
    error.message.includes(SANDBOX_SCOPE_REFUSAL.message)
  ) {
    return SANDBOX_SCOPE_REFUSAL;
  }
  return null;
}

/**
 * The one-line answer every catch-bearing route face gives the scope refusal — 503
 * with the fixed sentence, nothing else (no log line: the sentence IS the reason, and
 * it names no value to leak). A null return means "not a refusal": fall through to
 * the face's own masking branch. Folding the status code AND the
 * must-precede-the-masking-branch order into one helper is what keeps the next face
 * (skills/reload, #618 OCR#1) from mistyping or reordering the contract.
 */
export function scopeRefusalResponse(
  context: Context,
  error: unknown,
): Response | null {
  const refusal = sandboxScopeRefusalOf(error);
  return refusal ? context.json({ error: refusal.message }, 503) : null;
}
