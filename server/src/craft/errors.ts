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
