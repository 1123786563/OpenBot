/**
 * #618: recognize the fail-closed execution-scope refusal in whatever shape a route's
 * catch meets it — the error class itself, or (the archive walk's fold) a
 * WorkspaceListingError whose message embeds the cause's fixed sentence. Born in
 * file-routes.ts for the upload/archive/delete faces (R1-F2/r3) and hoisted here when
 * FR-F1 brought the session-lifecycle entrances (create/snapshot/restore) to the same
 * recognizer, so every craft face answers the one sentence the same way.
 */
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
