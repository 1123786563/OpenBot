/**
 * #618: recognize the fail-closed execution-scope refusal in whatever shape a route's
 * catch meets it — the error class itself, or (the archive walk's fold) a
 * WorkspaceListingError that carries the refusal structurally as its cause, with the
 * fixed sentence embedded in the text as the fallback for wraps built before the chain.
 * Born in file-routes.ts for the upload/archive/delete faces (R1-F2/r3) and hoisted here
 * when FR-F1 brought the session-lifecycle entrances (create/snapshot/restore) to the
 * same recognizer, so every craft face answers the one sentence the same way.
 */
import type { Context } from "hono";
import { WorkspaceListingError } from "./directory-archive";
import { SandboxExecutionScopeUnavailableError } from "./errors";

/**
 * The fixed sentence, matched on and rebuilt from — never carried by a shared Error
 * instance (#618 OCR r2): a matched refusal is rethrown into request chains, and one
 * error-enhancing layer rewriting a shared singleton's message would corrupt both the
 * 503 body every face answers with and the needle this recognizer matches on, silently.
 */
const REFUSAL_MESSAGE = new SandboxExecutionScopeUnavailableError().message;

export function sandboxScopeRefusalOf(
  error: unknown,
): SandboxExecutionScopeUnavailableError | null {
  if (error instanceof SandboxExecutionScopeUnavailableError) return error;
  if (error instanceof WorkspaceListingError) {
    // Structural first (#618 OCR r2): the wrap keeps its original cause, so the
    // refusal survives any rewrite of the wrap's text — a template change, a long-
    // cause truncation, an error enhancer touching the embedded sentence.
    if (error.cause instanceof SandboxExecutionScopeUnavailableError) {
      return new SandboxExecutionScopeUnavailableError();
    }
    // Fallback: wraps that carry no cause chain still answer by the fixed sentence
    // embedded in the text — the only shape every pre-chain wrap could produce.
    if (error.message.includes(REFUSAL_MESSAGE)) {
      return new SandboxExecutionScopeUnavailableError();
    }
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
