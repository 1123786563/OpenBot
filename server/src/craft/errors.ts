/**
 * Exception types raised by the craft session layer — ported from onyx `session/errors.py`.
 * Kept in a tiny module so callers can import them without pulling the manager's dependency
 * tree.
 */

/** Raised when an upload would exceed the per-session file count or total size limit. */
export class UploadLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadLimitExceededError";
  }
}

/** Raised when a sandbox is mid-provision and the caller cannot wait it out. */
export class SandboxProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxProvisioningError";
  }
}

/** A live provisioning attempt already owns the sandbox; the caller should retry shortly. */
export class SandboxProvisioningInProgressError extends SandboxProvisioningError {}

/** This attempt was superseded before it could finalize; its work must not be recorded. */
export class StaleProvisioningAttemptError extends SandboxProvisioningError {}

/**
 * #618: the sandbox gateway has no execution ownership to state. agent-sandbox's proxy
 * (MT050) refuses a token-only request, so a deployment whose scope wiring is missing
 * (or half missing) must refuse every outbound sandbox call here — never send an
 * unattributed request, never invent a default company or team. The sentence is fixed
 * (one refusal, every caller the same words) and deliberately names no id, token or
 * env variable: it is shown to people, and the fix is an admin's to make.
 */
export class SandboxExecutionScopeUnavailableError extends Error {
  constructor() {
    super(
      "The craft sandbox isn't assigned to a workspace yet. An admin has to finish its setup before craft sessions can run.",
    );
    this.name = "SandboxExecutionScopeUnavailableError";
  }
}
